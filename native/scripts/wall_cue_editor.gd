extends AcceptDialog

signal event_applied(wall_id: String, at_ms: int, ref: Dictionary, local_file: String)
var wall := OptionButton.new()
var when := SpinBox.new()
var offset := SpinBox.new()
var file_name := LineEdit.new()
var transport := OptionButton.new()
var file_dialog := FileDialog.new()
var local_file := ""
var initial: Dictionary = {}
var ids: Array = []

func _ready():
	title="LED wall cue"
	ok_button_text="Apply cue"
	add_cancel_button("Cancel")
	var column:=VBoxContainer.new()
	column.custom_minimum_size=Vector2(390,0)
	add_child(column)
	for entry in [["Wall",wall],["Show time (seconds)",when],["Video filename",file_name]]:
		add_row(column,entry[0],entry[1])
	var browse:=Button.new()
	browse.text="Choose MP4…"
	browse.pressed.connect(func(): file_dialog.popup_centered_ratio(0.7))
	column.add_child(browse)
	add_row(column,"Action",transport)
	for mode in ["Play","Hold","Clear"]: transport.add_item(mode)
	add_row(column,"Video position (seconds)",offset)
	when.step=0.01
	offset.step=0.01
	offset.max_value=86400
	wall.item_selected.connect(func(_i): refresh_media())
	confirmed.connect(commit_event)
	file_dialog.access=FileDialog.ACCESS_FILESYSTEM
	file_dialog.file_mode=FileDialog.FILE_MODE_OPEN_FILE
	file_dialog.filters=PackedStringArray(["*.mp4,*.mov ; MP4 and MOV"])
	file_dialog.file_selected.connect(func(path):
		local_file=path
		file_name.text=path.get_file()
	)
	add_child(file_dialog)

func add_row(parent: Control, caption: String, field: Control):
	var row:=HBoxContainer.new()
	parent.add_child(row)
	var title_label:=Label.new()
	title_label.text=caption
	title_label.custom_minimum_size.x=175
	row.add_child(title_label)
	field.size_flags_horizontal=Control.SIZE_EXPAND_FILL
	row.add_child(field)

func edit(labels: Dictionary, snapshot: Dictionary, duration: int):
	initial=snapshot.walls
	ids=labels.keys()
	wall.clear()
	for id in ids: wall.add_item(str(labels[id]))
	if ids.is_empty(): return
	when.max_value=duration/1000.0
	when.value=snapshot.positionMs/1000.0
	refresh_media()
	popup_centered()

func refresh_media():
	var data: Dictionary=initial.get(ids[wall.selected],{})
	local_file=""
	file_name.text=str(data.get("name",""))
	offset.value=float(data.get("offsetSeconds",0))
	transport.selected=2 if data.get("kind","none")!="video" else (0 if data.get("authoredPlaying",false) else 1)

func commit_event():
	if ids.is_empty(): return
	var target: String=ids[wall.selected]
	var name_of_file := file_name.text.strip_edges()
	var ref := {"target":target,"kind":"none","name":"","playing":false}
	if transport.selected!=2:
		if not name_of_file.is_valid_filename() or name_of_file!=name_of_file.get_file():
			var warn:=AcceptDialog.new()
			add_child(warn)
			warn.dialog_text="Choose a video or enter a filename without directories."
			warn.confirmed.connect(func(): warn.queue_free(); popup_centered())
			warn.popup_centered()
			return
		ref.merge({"kind":"video","name":name_of_file,"playing":transport.selected==0,"offsetSeconds":offset.value},true)
	event_applied.emit(target,roundi(when.value*1000),ref,local_file if local_file.get_file()==name_of_file else "")
