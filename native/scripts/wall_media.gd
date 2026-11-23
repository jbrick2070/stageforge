extends Node
## One independent native decoder and transport per stage screen.

const CACHE := "user://stageforge-video"
const COPY_CHUNK := 256 * 1024

var _player := VideoStreamPlayer.new()
var _source := ""
var _status := "No video"
var _playing := false
var _seek_msec := -10000
var _started_msec := 0


func _ready() -> void:
	_player.expand = true
	_player.size = Vector2.ONE
	_player.visible = false
	_player.volume_db = -80.0
	_player.loop = true
	add_child(_player)


func set_source(path: String) -> bool:
	if path == _source and _player.stream != null:
		return true
	_player.stop()
	_player.stream = null
	_playing = false
	_source = path
	if path.is_empty():
		_status = "No video"
		return false
	if RenderingServer.get_rendering_device()==null:
		_status = "Video requires a GPU renderer"
		return false
	if not ClassDB.class_exists("NativeVideoStream"):
		_status = "Native video extension missing"
		return false
	var native_path := _os_path(path)
	if native_path.is_empty():
		_status = "Could not open " + path.get_file()
		return false
	var stream := ClassDB.instantiate("NativeVideoStream") as VideoStream
	stream.file = native_path
	_player.stream = stream
	if _player.get_stream_length() <= 0.0:
		_status = "Video decoder could not read " + path.get_file()
		_player.stream = null
		return false
	_player.play()
	_player.paused = true
	_player.stream_position = 0.0
	_seek_msec = Time.get_ticks_msec()
	_started_msec = _seek_msec
	_status = path.get_file()
	return true


func _os_path(path: String) -> String:
	var physical := ProjectSettings.globalize_path(path)
	if (not path.begins_with("res://") or OS.has_feature("editor")) and FileAccess.file_exists(physical):
		return physical
	# Native platform decoders require a filesystem path. Built-in media in an
	# exported PCK is copied once and keyed by its contents across versions.
	if not path.begins_with("res://") or not FileAccess.file_exists(path):
		return ""
	var digest := FileAccess.get_sha256(path)
	if digest.is_empty() or DirAccess.make_dir_recursive_absolute(CACHE) != OK:
		return ""
	var target := ProjectSettings.globalize_path(CACHE.path_join(digest + "." + path.get_extension()))
	if FileAccess.file_exists(target):
		return target
	var source := FileAccess.open(path, FileAccess.READ)
	var temp := target + ".%d.%d.tmp" % [OS.get_process_id(), Time.get_ticks_usec()]
	var dest := FileAccess.open(temp, FileAccess.WRITE)
	if not source or not dest:
		return ""
	while source.get_position() < source.get_length():
		var chunk := source.get_buffer(mini(COPY_CHUNK, source.get_length() - source.get_position()))
		if chunk.is_empty() or not dest.store_buffer(chunk):
			dest.close()
			DirAccess.remove_absolute(temp)
			return ""
	dest.close()
	if DirAccess.rename_absolute(temp, target) != OK:
		DirAccess.remove_absolute(temp)
		if not FileAccess.file_exists(target):
			return ""
	return target


func sync_to(seconds: float, playing: bool, force_seek: bool = false) -> void:
	if _player.stream == null:
		return
	var duration := _player.get_stream_length()
	if duration <= 0.0:
		return
	var target := fposmod(maxf(0.0, seconds), duration)
	var distance := absf(_player.stream_position - target)
	var drift := minf(distance, absf(duration - distance))
	var now := Time.get_ticks_msec()
	var transport_changed := _playing != playing
	if not _player.is_playing():
		_player.play()
		force_seek = true
	_player.paused = not playing
	if force_seek or transport_changed or (drift > 0.3 and now - _seek_msec > 700):
		_player.stream_position = target
		_seek_msec = now
	_playing = playing


func texture() -> Texture2D:
	return _player.get_video_texture() if _player.stream != null else null


func status_text() -> String:
	if _player.stream and Time.get_ticks_msec() - _started_msec >= 3000:
		var current := texture()
		if not current or current.get_width() == 0:
			return "No decoded frame · check the OS codec or use H.264"
	return _status


func playback_position() -> float:
	return _player.stream_position if _player.stream != null else 0.0


func diagnostics() -> Dictionary:
	var frame := texture()
	return {"source": _source, "status": status_text(), "position": playback_position(),
		"length": _player.get_stream_length() if _player.stream != null else 0.0,
		"playing": _playing, "width": frame.get_width() if frame else 0,
		"height": frame.get_height() if frame else 0}
