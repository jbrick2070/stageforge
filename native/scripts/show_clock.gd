extends RefCounted
## Read-only native transport for the open StageForge show and optional stage sidecar.
## tick() is cheap between recorded changes. The monotonic clock never counts render frames.

var document: Dictionary = {}
var stage: Dictionary = {}
var cues: Array = []
var duration_ms := 0
var position_ms := 0
var playing := false

var _epoch_ms := 0
var _events: Array = []
var _side_events: Array = []
var _next_event := 0
var _next_side_event := 0
var _look: Dictionary = {}
var _music: Dictionary = {}
var _walls: Dictionary = {}
var _cue_id: Variant = null
var _volume := 0.72
var _camera := "foh"
var _bump: Dictionary = {}


func load_show(path: String, sidecar_path: String = "") -> String:
	var loaded: Variant = _read_document(path)
	if loaded is String:
		return loaded
	var side: Variant = {}
	if loaded.get("version")==3:
		side=loaded.get("stage")
		if not side is Dictionary or side.is_empty(): return "A v3 show requires an embedded stage."
	elif not sidecar_path.is_empty():
		side = _read_document(sidecar_path)
		if side is String:
			return side
	return load_documents(loaded, side)


func _read_document(path: String) -> Variant:
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		return "Cannot open %s: %s" % [path, error_string(FileAccess.get_open_error())]
	var parser := JSON.new()
	if parser.parse(file.get_as_text()) != OK:
		return "%s, line %s: %s" % [path.get_file(), parser.get_error_line(), parser.get_error_message()]
	if not parser.data is Dictionary:
		return "%s must contain a JSON object." % path.get_file()
	return parser.data


func load_documents(show: Dictionary, side: Dictionary = {}) -> String:
	var version: Variant=show.get("version")
	if show.get("format") != "stageforge-show" or (version!=1 and version!=2 and version!=3):
		return "Expected a version 1, 2 or 3 StageForge show."
	if show.get("version")==3 and side.is_empty():
		if not show.get("stage") is Dictionary: return "A v3 show requires an embedded stage."
		side=show.stage
	if not show.get("rig") is Dictionary or not show.get("look") is Dictionary or not show.get("cues") is Array:
		return "The show needs a rig, a saved look and a cue list."
	for entry in show.cues:
		if not entry is Dictionary or not entry.get("id") is String or not entry.get("name") is String:
			return "Invalid cue in the show."
	var take: Variant = show.get("timeline", {"durationMs": 0, "events": []})
	if not take is Dictionary or not _valid_ms(take.get("durationMs")) or not take.get("events") is Array:
		return "Invalid recorded timeline."
	var media: Variant = show.get("media", {})
	if not media is Dictionary or not show.get("controls", {}) is Dictionary:
		return "Invalid saved media or desk controls."
	var problem := _check_media_event(media, ["main-led"])
	if not problem.is_empty():
		return problem
	var wall_ids := ["main-led"]
	if not side.is_empty():
		if side.get("format") != "stageforge-native-stage" or side.get("version") != 1:
			return "Unsupported native stage sidecar."
		if not side.get("walls") is Array or not side.get("screenEvents", []) is Array:
			return "Invalid wall list or screen event list."
		if side.walls.size()>8 or not valid_layout(side.get("layout",{})):
			return "Invalid stage layout."
		var seen := {}
		for wall in side.walls:
			if not wall is Dictionary or not wall.get("id") is String or wall.id.strip_edges().is_empty() or seen.has(wall.id):
				return "Each wall needs a unique nonempty ID."
			seen[wall.id] = true
			for key in ["x","y","z","width","height","yaw"]:
				if wall.has(key) and not finite_number(wall[key]): return "Invalid wall dimensions."
			if wall.id != "main-led":
				wall_ids.append(wall.id)
	var last := 0
	for event in take.events:
		if not _ordered(event, last, int(take.durationMs)):
			return "Show event times must be ordered and inside the recording."
		last = int(event.atMs)
		if (event.has("look") and not event.look is Dictionary) or (event.has("bump") and not event.bump is Dictionary):
			return "Invalid recorded lighting look or momentary controls."
		problem = _check_media_event(event, ["main-led"])
		if not problem.is_empty():
			return problem
	last = 0
	for event in side.get("screenEvents", []):
		if not _ordered(event, last, int(take.durationMs)):
			return "Wall event times must be ordered and inside the recording."
		last = int(event.atMs)
		if event.get("target") == "main-led" or not _valid_ref(event, false, wall_ids):
			return "A sidecar event needs a declared secondary wall and a portable media reference."

	# Replace the last good show only after both incoming documents are valid.
	document = show
	stage = side
	duration_ms = int(take.durationMs)
	_events = take.events
	_side_events = side.get("screenEvents", [])
	var names := {}
	for cue in show.cues:
		names[cue.id] = cue.name
	cues = []
	for event in _events:
		if event.get("cueId") is String:
			cues.append({"atMs": int(event.atMs), "cueId": event.cueId, "name": names.get(event.cueId, event.cueId)})
	playing = false
	position_ms = 0
	_reset()
	_consume(0)
	return ""


func finite_number(v: Variant) -> bool:
	return (v is int or v is float) and is_finite(float(v))

func valid_layout(layout: Variant) -> bool:
	if not layout is Dictionary or not layout.get("replace",false) is bool: return false
	var keys := {"trusses":["x","z","endX","endZ","height"],"hangs":["x","y","z","yaw","tilt","count","splay"],"props":["x","z","height"]}
	for kind in keys:
		var items: Variant=layout.get(kind,[])
		if not items is Array or items.size()>128: return false
		for item in items:
			if not item is Dictionary: return false
			for key in keys[kind]:
				if not finite_number(item.get(key)): return false
			if kind=="props" and item.get("type") not in ["inflatable","scenic"]: return false
	return true


func _valid_ms(value: Variant) -> bool:
	return (value is int or value is float) and is_finite(float(value)) and value >= 0 and floor(float(value)) == value and value < 9.0e15


func _ordered(event: Variant, last: int, duration: int) -> bool:
	return event is Dictionary and _valid_ms(event.get("atMs")) and last <= event.atMs and event.atMs <= duration


func _check_media_event(event: Dictionary, ids: Array) -> String:
	if event.has("music") and not _valid_ref(event.music, true, ids):
		return "Invalid music reference or filename."
	if event.has("screen") and not _valid_ref(event.screen, false, ids):
		return "Invalid screen reference or filename."
	return ""


func _valid_ref(ref: Variant, music: bool, ids: Array) -> bool:
	if not ref is Dictionary or not ref.get("name") is String or not ref.get("playing") is bool:
		return false
	if not music and ref.get("target") not in ids:
		return false
	var kinds := ["none", "demo", "file", "live"] if music else ["none", "video", "image"]
	if ref.get("kind") not in kinds:
		return false
	for field in ["offsetSeconds", "demoStep"]:
		var value: Variant = ref.get(field, 0)
		if not (value is int or value is float) or not is_finite(float(value)) or value < 0:
			return false
	if ref.kind in ["video", "image", "file"]:
		var filename: String = ref.name
		return not filename.is_empty() and filename not in [".", ".."] and filename.is_valid_filename() and filename == filename.get_file()
	return true


func _reset() -> void:
	_next_event = 0
	_next_side_event = 0
	_look = document.look.duplicate()
	_cue_id = document.get("activeCueId")
	_volume = float(document.get("controls", {}).get("volume", 0.72))
	_camera = str(document.get("controls", {}).get("camera", "foh"))
	_bump = {}
	var media: Dictionary = document.get("media", {})
	_music = _anchor(media.get("music", _empty_media()), 0)
	_walls = {"main-led": _anchor(media.get("screen", _empty_media()), 0)}
	for wall in stage.get("walls", []):
		if not _walls.has(wall.id):
			_walls[wall.id] = _anchor(_empty_media(), 0)


func _empty_media() -> Dictionary:
	return {"kind": "none", "name": "", "playing": false}


func _anchor(ref: Dictionary, at_ms: int) -> Dictionary:
	var result := ref.duplicate()
	result.erase("atMs")
	result.startMs = at_ms
	result.authoredPlaying = ref.playing
	return result


func _consume(target_ms: int) -> void:
	while _next_event < _events.size() and _events[_next_event].atMs <= target_ms:
		var event: Dictionary = _events[_next_event]
		var at_ms := int(event.atMs)
		if event.has("look"):
			if event.look.has("bpm") and _music.kind == "demo" and not event.has("music"):
				# Accumulate the old tempo's steps before applying the next tempo.
				var advanced := _media_at(_music, at_ms, true)
				advanced.playing = advanced.authoredPlaying
				_music = _anchor(advanced, at_ms)
			_look = _look.merged(event.look, true)
		if event.has("music"):
			_music = _anchor(event.music, at_ms)
		if event.has("screen"):
			_walls["main-led"] = _anchor(event.screen, at_ms)
		_cue_id = event.get("cueId", _cue_id)
		_volume = float(event.get("volume", _volume))
		_camera = str(event.get("camera", _camera))
		_bump = event.get("bump", _bump)
		_next_event += 1
	while _next_side_event < _side_events.size() and _side_events[_next_side_event].atMs <= target_ms:
		var event: Dictionary = _side_events[_next_side_event]
		_walls[event.target] = _anchor(event, int(event.atMs))
		_next_side_event += 1


func _media_at(ref: Dictionary, at_ms: int, music: bool) -> Dictionary:
	var result := ref.duplicate()
	var elapsed := (at_ms - int(ref.startMs)) / 1000.0 if ref.authoredPlaying else 0.0
	result.playing = playing and ref.authoredPlaying
	var bpm := maxf(1.0, float(_look.get("bpm", 128)))
	var demo: bool = music and ref.kind == "demo"
	var initial := float(ref.get("offsetSeconds", float(ref.get("demoStep", 0)) * 15.0 / bpm if demo else 0.0))
	result.offsetSeconds = initial + elapsed
	if demo:
		result.demoStep = minf(1024.0, float(ref.get("demoStep", 0)) + elapsed * bpm / 15.0)
	return result


func seek(ms: int) -> void:
	if document.is_empty():
		return
	var target := clampi(ms, 0, duration_ms)
	if target < position_ms:
		_reset()
	position_ms = target
	_consume(target)
	if position_ms == duration_ms:
		playing = false
	_epoch_ms = Time.get_ticks_msec() - position_ms


func jump_to_cue(index: int) -> void:
	if index >= 0 and index < cues.size():
		seek(int(cues[index].atMs))


func play() -> void:
	if playing or duration_ms == 0:
		return
	if position_ms >= duration_ms:
		seek(0)
	_epoch_ms = Time.get_ticks_msec() - position_ms
	playing = true


func pause() -> void:
	tick()
	playing = false


func tick() -> void:
	if playing:
		position_ms = mini(duration_ms, Time.get_ticks_msec() - _epoch_ms)
		_consume(position_ms)
		if position_ms == duration_ms:
			playing = false


func snapshot() -> Dictionary:
	if document.is_empty():
		return {}
	var walls := {}
	for id in _walls:
		var ref := _media_at(_walls[id], position_ms, false)
		ref.id = id
		ref.target = id
		walls[id] = ref
	return {"positionMs": position_ms, "playing": playing, "cueId": _cue_id, "look": _look,
		"blackout": _look.get("blackout", false), "volume": _volume, "camera": _camera,
		"bump": _bump, "music": _media_at(_music, position_ms, true), "walls": walls}
