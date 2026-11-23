extends Node

const ShowClock = preload("res://scripts/show_clock.gd")
const StageView = preload("res://scripts/stage.gd")
const WallMedia = preload("res://scripts/wall_media.gd")
const EXAMPLE := "res://examples/split-rig.stageforge.show.json"
const ACCENT := Color("#a0f0d3")
const MUTED := Color("#adbac6")

var clock = ShowClock.new()
var stage = StageView.new()
var music := AudioStreamPlayer.new()
var walls: Dictionary = {}
var root_ui := Control.new()
var play_button := Button.new()
var slider := HSlider.new()
var time_readout := Label.new()
var name_readout := Label.new()
var message := Label.new()
var cue_row := HBoxContainer.new()
var wall_row := HBoxContainer.new()
var dialog := FileDialog.new()
var save_dialog := FileDialog.new()
var editor = preload("res://scripts/plan_editor.gd").new()
var wall_editor = preload("res://scripts/wall_cue_editor.gd").new()
var linked_files := {}
var work_lights := false
var work_button := Button.new()
var dirty := false
var media_folder := ""
var events: Dictionary = {}
var source_names: Dictionary = {}
var last_music := ""
var dragging := false
var cue_buttons: Array = []
var wall_labels: Dictionary = {}
var qa_report := ""
var last_snapshot: Dictionary = {}
var wall_paths: Dictionary = {}
var update_at := 0
var mute_button := Button.new()

func _ready():
	add_child(stage)
	add_child(music)
	make_desk()
	var path := EXAMPLE
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--qa-report="): qa_report = arg.trim_prefix("--qa-report=")
		if arg.begins_with("--show="): path = arg.trim_prefix("--show=")
	open_show(path)
	if qa_report!="": call_deferred("run_qa")

func style(bg: Color, outline: Color, radius := 5) -> StyleBoxFlat:
	var s := StyleBoxFlat.new()
	s.bg_color = bg
	s.border_color = outline
	s.set_border_width_all(1)
	s.set_corner_radius_all(radius)
	s.content_margin_left = 14
	s.content_margin_right = 14
	s.content_margin_top = 8
	s.content_margin_bottom = 8
	return s

func label(text: String, size: int, color: Color) -> Label:
	var obj := Label.new()
	obj.text = text
	obj.add_theme_font_size_override("font_size",size)
	obj.modulate = color
	return obj

func action(btn: Button, title: String, callback: Callable, tooltip := ""):
	btn.text = title
	btn.tooltip_text = tooltip
	btn.focus_mode = Control.FOCUS_CLICK
	btn.pressed.connect(callback)

func make_desk():
	var layer := CanvasLayer.new()
	add_child(layer)
	layer.add_child(root_ui)
	root_ui.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	root_ui.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var theme := Theme.new()
	theme.default_font_size = 16
	theme.set_stylebox("normal","Button",style(Color("#25313b"),Color("#41505c")))
	theme.set_stylebox("hover","Button",style(Color("#344650"),ACCENT))
	theme.set_stylebox("pressed","Button",style(Color("#174d40"),ACCENT))
	theme.set_color("font_color","Button",Color("#eef5f5"))
	root_ui.theme = theme
	var top := PanelContainer.new()
	root_ui.add_child(top)
	top.set_anchors_and_offsets_preset(Control.PRESET_TOP_WIDE)
	top.add_theme_stylebox_override("panel",style(Color("#101820"),Color("#293641"),0))
	var top_row := HBoxContainer.new()
	top_row.add_theme_constant_override("separation",18)
	top.add_child(top_row)
	top_row.add_child(label("StageForge",23,ACCENT))
	name_readout.add_theme_font_size_override("font_size",18)
	name_readout.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	top_row.add_child(name_readout)
	var plan := Button.new()
	action(plan,"Stage plan",func(): editor.edit(clock.document.rig,clock.stage.get("layout",{})))
	top_row.add_child(plan)
	add_child(editor)
	editor.layout_applied.connect(apply_layout)
	var videos := Button.new()
	action(videos,"Wall cue",edit_wall)
	top_row.add_child(videos)
	root_ui.add_child(wall_editor)
	wall_editor.event_applied.connect(change_wall)
	action(work_button,"Work lights",toggle_work,"Illuminate the stage while designing")
	top_row.add_child(work_button)
	action(mute_button,"Mute",toggle_mute,"Mute rehearsal music")
	top_row.add_child(mute_button)
	var open := Button.new()
	action(open,"Open show…",func(): dialog.popup_centered_ratio(0.7))
	top_row.add_child(open)
	var save := Button.new()
	action(save,"Save show as…",func(): save_dialog.popup_centered_ratio(0.7))
	top_row.add_child(save)
	dialog.file_mode = FileDialog.FILE_MODE_OPEN_FILE
	dialog.access = FileDialog.ACCESS_FILESYSTEM
	dialog.filters = PackedStringArray(["*.stageforge.show.json ; StageForge show", "*.json ; JSON"])
	dialog.title = "Open StageForge show"
	dialog.file_selected.connect(open_show)
	root_ui.add_child(dialog)
	save_dialog.file_mode=FileDialog.FILE_MODE_SAVE_FILE
	save_dialog.access=FileDialog.ACCESS_FILESYSTEM
	save_dialog.filters=PackedStringArray(["*.stageforge.show.json ; StageForge show"])
	save_dialog.title="Save show and copy linked media"
	save_dialog.file_selected.connect(save_show)
	root_ui.add_child(save_dialog)
	var notices := AcceptDialog.new()
	notices.title = "Licenses"
	var license_text:=TextEdit.new()
	license_text.custom_minimum_size=Vector2(640,350)
	license_text.editable=false
	license_text.wrap_mode=TextEdit.LINE_WRAPPING_BOUNDARY
	notices.add_child(license_text)
	root_ui.add_child(notices)
	var footer := PanelContainer.new()
	root_ui.add_child(footer)
	footer.set_anchors_and_offsets_preset(Control.PRESET_BOTTOM_WIDE)
	footer.grow_vertical = Control.GROW_DIRECTION_BEGIN
	footer.add_theme_stylebox_override("panel",style(Color("#101820"),Color("#31414d"),0))
	var stack := VBoxContainer.new()
	stack.add_theme_constant_override("separation",5)
	footer.add_child(stack)
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation",14)
	stack.add_child(row)
	action(play_button,"Play",toggle_play,"Space · play or pause")
	play_button.custom_minimum_size.x = 94
	row.add_child(play_button)
	time_readout.custom_minimum_size.x = 148
	row.add_child(time_readout)
	slider.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	slider.step = 10
	slider.drag_started.connect(func(): dragging = true)
	slider.drag_ended.connect(func(_changed): dragging = false)
	slider.value_changed.connect(func(value): seek_to(int(value)))
	row.add_child(slider)
	var reset := Button.new()
	action(reset,"Restart",func(): seek_to(0))
	row.add_child(reset)
	stack.add_child(cue_row)
	cue_row.add_theme_constant_override("separation",8)
	stack.add_child(wall_row)
	wall_row.add_theme_constant_override("separation",24)
	var credit:=LinkButton.new()
	credit.text="Licenses"
	credit.pressed.connect(func():
		if license_text.text.is_empty(): license_text.text=credits_text()
		notices.popup_centered()
	)
	top_row.add_child(credit)
	message.modulate = Color("#fac397")
	message.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	message.hide()
	stack.add_child(message)

func toggle_mute():
	music.volume_db = -80 if not music.volume_db<=-79 else linear_to_db(maxf(0.001,float(last_snapshot.get("volume",0.45))))
	mute_button.text = "Unmute" if music.volume_db<=-79 else "Mute"

func credits_text() -> String:
	var parts:=PackedStringArray([FileAccess.get_file_as_string("res://THIRD_PARTY.txt")])
	for entry in Engine.get_copyright_info():
		parts.append(str(entry.name))
		for part in entry.parts:
			parts.append("\n".join(part.copyright))
			parts.append(str(part.license))
	var included:=Engine.get_license_info()
	for key in included:
		parts.append(str(key))
		parts.append(str(included[key]))
	return "\n".join(parts)

func error_message(text: String):
	message.text = text
	message.visible = not text.is_empty()

func clear_items(parent: Node):
	for child in parent.get_children():
		parent.remove_child(child)
		child.queue_free()

func open_show(path: String):
	var side := path.trim_suffix(".stageforge.show.json")+".stageforge.stage.json"
	if side==path or not FileAccess.file_exists(side): side=""
	var error: String = clock.load_show(path,side)
	if not error.is_empty():
		error_message(error)
		return
	music.stop()
	music.stream = null
	last_music = ""
	mute_button.text = "Mute"
	last_snapshot = {}
	linked_files.clear()
	dirty=false
	work_lights=false
	work_button.modulate=Color.WHITE
	media_folder = path.get_base_dir()
	clear_items(cue_row)
	clear_items(wall_row)
	for decoder in walls.values(): decoder.queue_free()
	walls.clear()
	events.clear()
	source_names.clear()
	wall_paths.clear()
	cue_buttons.clear()
	wall_labels.clear()
	stage.configure(clock.document.rig,clock.stage)
	name_readout.text = str(clock.document.rig.get("name",path.get_file()))
	save_dialog.current_file=path.get_file()
	for id in stage.displays:
		var decoder = WallMedia.new()
		add_child(decoder)
		walls[id] = decoder
		var tag := label("",14,MUTED)
		wall_row.add_child(tag)
		wall_labels[id] = tag
	prime_wall_media()
	slider.max_value = maxi(clock.duration_ms,1)
	var index := 0
	for event in clock.cues:
		var btn := Button.new()
		action(btn,"%s   %s" % [time_string(event.atMs),event.name],seek_to.bind(int(event.atMs)))
		cue_row.add_child(btn)
		cue_buttons.append(btn)
		index+=1
		if index>=24: break
	error_message("")
	apply_transport(true)

func prime_wall_media():
	# Open the first clip while loading the rig. Its surface stays dark until its cue.
	var refs: Array = [clock.document.get("media",{}).get("screen",{})]
	for event in clock.document.get("timeline",{}).get("events",[]):
		if event.has("screen"): refs.append(event.screen)
	refs.append_array(clock.stage.get("screenEvents",[]))
	for ref in refs:
		var id: String=ref.get("target","")
		var filename: String=ref.get("name","")
		if ref.get("kind")!="video" or not walls.has(id) or source_names.has(id): continue
		if not filename.is_valid_filename() or filename!=filename.get_file(): continue
		var file_path:=find_media(filename)
		if walls[id].set_source(file_path):
			wall_paths[id]=file_path
			source_names[id]=filename

func toggle_play():
	if clock.playing: clock.pause()
	else: clock.play()
	apply_transport(true)

func seek_to(ms: int):
	clock.seek(ms)
	apply_transport(true)

func _unhandled_key_input(event: InputEvent):
	if event is InputEventKey and event.pressed and not event.echo and event.keycode==KEY_SPACE and not dialog.visible:
		toggle_play()
		get_viewport().set_input_as_handled()

func time_string(ms: int) -> String:
	return "%d:%02d.%d" % [ms/60000,(ms/1000)%60,(ms%1000)/100]

func _process(_delta: float):
	if clock.document.is_empty(): return
	clock.tick()
	apply_transport(false)

func sync_music(snap: Dictionary, force: bool):
	var data: Dictionary = snap.music
	var kind := str(data.get("kind","none"))
	var next := str(data.get("name","")) if kind in ["demo","file"] else ""
	if last_music!=next:
		last_music=next
		music.stop()
		music.stream=null
		if kind=="demo" and next=="Arena Anthem":
			music.stream=preload("res://examples/arena-anthem.ogg")
		elif kind=="file" and not next.is_empty() and next==next.get_file():
			var path := find_media(next)
			if FileAccess.file_exists(path):
				match path.get_extension().to_lower():
					"mp3": music.stream=AudioStreamMP3.load_from_file(path)
					"ogg": music.stream=AudioStreamOggVorbis.load_from_file(path)
					"wav": music.stream=AudioStreamWAV.load_from_file(path)
		force=true
	if music.stream==null: return
	if mute_button.text!="Unmute": music.volume_db = linear_to_db(maxf(0.0001,float(snap.volume)))
	var offset := float(data.get("offsetSeconds",0))
	if offset>=music.stream.get_length():
		if music.playing: music.stop()
		return
	if data.get("playing",false):
		if not music.playing or music.stream_paused:
			music.stream_paused=false
			music.play(offset)
		elif force: music.seek(offset)
	elif force:
		music.stream_paused=false
		music.play(offset)
		music.stream_paused=true
	elif music.playing:
		music.stream_paused=true

func apply_transport(force: bool):
	if clock.document.is_empty(): return
	var snap: Dictionary = clock.snapshot()
	last_snapshot = snap
	var seconds: float = clock.position_ms/1000.0
	stage.apply_look(snap.look,seconds)
	if work_lights:
		stage.work_light.light_energy=1.25
		stage.world.ambient_light_energy=0.7
	sync_music(snap,force)
	var led: Dictionary = snap.look.get("led",{})
	var led_level := 0.0 if snap.blackout or not led.get("enabled",true) else float(led.get("brightness",1.0))
	for id in walls:
		var data: Dictionary = snap.walls.get(id,{})
		var name_of_file := str(data.get("name","")) if data.get("kind","none")=="video" else ""
		var adapter = walls[id]
		if not name_of_file.is_empty() and source_names.get(id,null)!=name_of_file:
			source_names[id]=name_of_file
			var file_path := ""
			if name_of_file!="" and name_of_file==name_of_file.get_file():
				file_path=find_media(name_of_file)
			wall_paths[id]=file_path
			adapter.set_source(file_path)
		var event_ms = data.get("startMs",-1)
		adapter.sync_to(float(data.get("offsetSeconds",0)),data.get("playing",false),force or events.get(id,-2)!=event_ms)
		events[id]=event_ms
		stage.show_frame(id,adapter.texture() if name_of_file!="" else null,led_level)
	var now := Time.get_ticks_msec()
	if not force and now<update_at: return
	update_at=now+80
	play_button.text = "Pause" if clock.playing else "Play"
	time_readout.text = "%s / %s" % [time_string(clock.position_ms),time_string(clock.duration_ms)]
	if not dragging: slider.set_value_no_signal(clock.position_ms)
	for i in cue_buttons.size():
		var active: bool = clock.position_ms>=clock.cues[i].atMs and (i+1==clock.cues.size() or clock.position_ms<clock.cues[i+1].atMs)
		cue_buttons[i].modulate = ACCENT if active else Color.WHITE
	for id in walls:
		var wall = walls[id]
		var data: Dictionary = snap.walls.get(id,{})
		var state := "Playing" if data.get("playing",false) else "Hold"
		var text := "%s   %s" % [str(id).to_upper(),wall.status_text() if data.get("kind")=="video" else "No video"]
		if data.get("kind")=="video": text += "   %s  %.1fs" % [state,float(data.get("offsetSeconds",0))]
		wall_labels[id].text = text

func run_qa():
	var probe = preload("res://scripts/rehearsal_probe.gd").new()
	await probe.run(self,qa_report)

func find_media(filename: String) -> String:
	if linked_files.has(filename): return linked_files[filename]
	var local:=media_folder.path_join(filename)
	if FileAccess.file_exists(local): return local
	var bundled:="res://examples/"+filename
	return bundled if FileAccess.file_exists(bundled) else local

func toggle_work():
	work_lights=not work_lights
	work_button.modulate=ACCENT if work_lights else Color.WHITE

func mark_edited():
	dirty=true
	name_readout.text=str(clock.document.rig.get("name","Show"))+"  •"

func stage_data() -> Dictionary:
	if not clock.stage.is_empty(): return clock.stage.duplicate(true)
	var walls_config: Array=[]
	if stage.displays.has("main-led"): walls_config.append({"id":"main-led"})
	return {"format":"stageforge-native-stage","version":1,"walls":walls_config,"screenEvents":[]}

func apply_layout(layout: Dictionary):
	if clock.document.is_empty(): return
	var updated:=stage_data()
	updated.layout=layout
	clock.stage=updated
	stage.configure(clock.document.rig,clock.stage)
	work_lights=true
	work_button.modulate=ACCENT
	mark_edited()
	apply_transport(true)

func edit_wall():
	if clock.document.is_empty(): return
	var names: Dictionary={}
	for id in walls: names[id]=id
	for wall in clock.stage.get("walls",[]):
		if names.has(wall.id): names[wall.id]=wall.get("label",wall.id)
	if names.is_empty():
		error_message("Open a rig with an LED wall to program video.")
		return
	wall_editor.edit(names,last_snapshot,clock.duration_ms)

func change_wall(id: String, ms: int, ref: Dictionary, physical_path: String):
	var show: Dictionary=clock.document.duplicate(true)
	var updated:=stage_data()
	var at:int=clock.position_ms
	if id=="main-led":
		if not show.has("timeline"): show.timeline={"durationMs":clock.duration_ms,"events":[]}
		var added:=false
		for event in show.timeline.events:
			if int(event.atMs)==ms:
				event.screen=ref.duplicate()
				for cue in show.cues:
					if cue.id==event.get("cueId",""): cue.screen=ref.duplicate()
				added=true
		if not added: show.timeline.events.append({"atMs":ms,"screen":ref})
		show.timeline.events.sort_custom(func(a,b): return a.atMs<b.atMs)
	else:
		var sequence:Array=updated.get("screenEvents",[]).filter(func(event): return event.target!=id or int(event.atMs)!=ms)
		var change:=ref.duplicate()
		change.atMs=ms
		sequence.append(change)
		sequence.sort_custom(func(a,b): return a.atMs<b.atMs)
		updated.screenEvents=sequence
	var problem:String=clock.load_documents(show,updated)
	if not problem.is_empty():
		error_message(problem)
		return
	if not physical_path.is_empty():
		linked_files[physical_path.get_file()]=physical_path
		source_names.erase(id)
	mark_edited()
	seek_to(at)

func save_show(path: String):
	if clock.document.is_empty(): return
	if not path.ends_with(".stageforge.show.json"): path=path.trim_suffix(".json")+".stageforge.show.json"
	var show: Dictionary=clock.document.duplicate(true)
	if not clock.stage.is_empty():
		show.version=3
		show["$schema"]="https://jbrick2070.github.io/stageforge/schemas/show-v3.schema.json"
		show.stage=clock.stage.duplicate(true)
	var io = preload("res://scripts/design_io.gd")
	var missing:=PackedStringArray()
	for filename in io.referenced_names(show,clock.stage):
		if not str(filename).is_valid_filename() or filename!=str(filename).get_file():
			error_message("Cannot save a non-portable media filename.")
			return
		var source:=find_media(filename)
		if not FileAccess.file_exists(source):
			missing.append(filename)
			continue
		var problem:String=io.copy_media(source,path.get_base_dir().path_join(filename))
		if not problem.is_empty():
			error_message(problem)
			return
	var temp:=path+".%s.tmp"%OS.get_process_id()
	var f:=FileAccess.open(temp,FileAccess.WRITE)
	if f==null:
		error_message("Cannot write to the selected folder.")
		return
	var wrote:=f.store_string(JSON.stringify(show,"  "))
	f.close()
	if not wrote or DirAccess.rename_absolute(temp,path)!=OK:
		DirAccess.remove_absolute(temp)
		error_message("Could not save the show.")
		return
	clock.document=show
	media_folder=path.get_base_dir()
	dirty=false
	name_readout.text=str(show.rig.get("name","Show"))
	error_message("Saved "+path.get_file()+("." if missing.is_empty() else ". Missing media: "+", ".join(missing)))
