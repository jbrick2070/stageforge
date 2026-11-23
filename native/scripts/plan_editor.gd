extends Window

signal layout_applied(layout: Dictionary)

const MODES := ["Select", "Draw truss", "Speaker hang", "Inflatable", "Scenery"]
const STEEL := Color("#98c4d7")
const HANG := Color("#f5c47b")
const PROP := Color("#c29aeb")
const ACCENT := Color("#91e3c0")
const MUTED := Color("#99afbc")
const MAX_OBJECTS := 32

class PlanCanvas extends Control:
	var editor

	func _draw() -> void:
		editor.draw_plan(self)

	func _gui_input(event: InputEvent) -> void:
		if event is InputEventMouseMotion:
			editor.hover_point = editor.world_at(event.position)
			if editor.first_point != null: queue_redraw()
		elif event is InputEventMouseButton and event.pressed:
			if event.button_index == MOUSE_BUTTON_LEFT:
				editor.click_plan(editor.world_at(event.position))
				accept_event()
			elif event.button_index == MOUSE_BUTTON_RIGHT:
				editor.pick_tool(0)
				accept_event()

var canvas := PlanCanvas.new()
var tools_row := HBoxContainer.new()
var inspector := VBoxContainer.new()
var inspector_title := Label.new()
var hint := Label.new()
var counts := Label.new()
var tool_buttons: Array = []
var editors: Dictionary = {}
var rig: Dictionary = {}
var draft: Dictionary = {}
var tool := 0
var selected := ""
var selection := -1
var first_point: Variant = null
var hover_point := Vector2.ZERO
var extent := Vector2(7, 6)


func _ready() -> void:
	title = "Stage plan"
	transient = true
	exclusive = true
	min_size = Vector2i(720, 500)
	size = Vector2i(940, 610)
	visible = false
	close_requested.connect(hide)
	var background := ColorRect.new()
	background.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	background.color = Color("#1a252f")
	background.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(background)
	var margin := MarginContainer.new()
	var theme_style := Theme.new()
	theme_style.default_font_size = 15
	theme_style.set_stylebox("normal", "Button", _button_style("#233440", "#455966"))
	theme_style.set_stylebox("hover", "Button", _button_style("#324854", "#79b8a2"))
	theme_style.set_stylebox("pressed", "Button", _button_style("#215044", "#91e3c0"))
	margin.theme = theme_style
	margin.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	for edge in ["margin_left", "margin_top", "margin_right", "margin_bottom"]:
		margin.add_theme_constant_override(edge, 14)
	add_child(margin)
	var column := VBoxContainer.new()
	column.add_theme_constant_override("separation", 10)
	margin.add_child(column)
	column.add_child(tools_row)
	tools_row.add_theme_constant_override("separation", 6)
	var group := ButtonGroup.new()
	for i in MODES.size():
		var button := Button.new()
		button.text = MODES[i]
		button.toggle_mode = true
		button.button_group = group
		button.pressed.connect(pick_tool.bind(i))
		tools_row.add_child(button)
		tool_buttons.append(button)
	var row := HBoxContainer.new()
	row.size_flags_vertical = Control.SIZE_EXPAND_FILL
	row.add_theme_constant_override("separation", 16)
	column.add_child(row)
	canvas.editor = self
	canvas.clip_contents = true
	canvas.mouse_default_cursor_shape = Control.CURSOR_CROSS
	canvas.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	canvas.size_flags_vertical = Control.SIZE_EXPAND_FILL
	canvas.resized.connect(canvas.queue_redraw)
	row.add_child(canvas)
	var panel := VBoxContainer.new()
	panel.custom_minimum_size.x = 195
	panel.add_theme_constant_override("separation", 10)
	row.add_child(panel)
	inspector_title.add_theme_font_size_override("font_size", 18)
	panel.add_child(inspector_title)
	panel.add_child(inspector)
	panel.add_child(counts)
	counts.modulate = MUTED
	panel.add_child(_button("Blank floor", blank_layout))
	panel.add_child(_button("Restore show layout", restore_layout))
	hint.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	hint.modulate = ACCENT
	column.add_child(hint)
	var footer := HBoxContainer.new()
	footer.alignment = BoxContainer.ALIGNMENT_END
	footer.add_child(_button("Cancel", hide))
	footer.add_child(_button("Apply layout", apply_layout))
	column.add_child(footer)


func _button(caption: String, callback: Callable) -> Button:
	var result := Button.new()
	result.text = caption
	result.pressed.connect(callback)
	return result


func _button_style(background: String, border: String) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = Color(background)
	style.border_color = Color(border)
	style.set_border_width_all(1)
	style.set_corner_radius_all(4)
	style.content_margin_left = 8
	style.content_margin_right = 8
	style.content_margin_top = 4
	style.content_margin_bottom = 4
	return style


func edit(source_rig: Dictionary, layout: Dictionary) -> void:
	rig = source_rig
	draft = layout.duplicate(true)
	selected = ""
	selection = -1
	_reset_extent()
	pick_tool(0)
	refresh_form()
	popup_centered_clamped(Vector2i(940, 610), 0.95)


func apply_layout() -> void:
	layout_applied.emit(draft.duplicate(true))
	hide()


func blank_layout() -> void:
	draft = {"replace": true, "trusses": [], "hangs": [], "props": []}
	selected = ""
	selection = -1
	_reset_extent()
	pick_tool(0)
	refresh_form()


func restore_layout() -> void:
	draft = {}
	selected = ""
	selection = -1
	_reset_extent()
	pick_tool(0)
	refresh_form()


func pick_tool(index: int) -> void:
	tool = index
	first_point = null
	for i in tool_buttons.size():
		tool_buttons[i].set_pressed_no_signal(i == index)
	hint.text = [
		"Click a speaker hang, placed truss or prop to edit it.",
		"Click the two ends of a truss. Right-click to cancel.",
		"Click the hang point, then set the array angles and box count.",
		"Click to place an inflatable.",
		"Click to place a scenic prop."
	][index]
	canvas.queue_redraw()


func hangs() -> Array:
	if draft.has("hangs"): return draft.hangs
	var audio: Dictionary = rig.get("audioRig", {})
	if draft.get("replace", false) or not audio.get("lineArrays", false): return []
	var result := []
	var width := clampf(rig.get("stageWidth", 8), 3, 40)
	for side in [-1, 1]:
		result.append({"x": side * (width * 0.5 + 0.35), "y": 4.1, "z": 1.0,
			"yaw": 0.0, "tilt": 0.0, "count": int(audio.get("boxesPerSide", 4)), "splay": 4.0})
	return result


func _items(key: String) -> Array:
	return hangs() if key == "hangs" else draft.get(key, [])


func _mutable_items(key: String) -> Array:
	if not draft.has(key): draft[key] = _items(key).duplicate(true)
	return draft[key]


func _reset_extent() -> void:
	extent = Vector2(maxf(6.5, float(rig.get("stageWidth", 8)) * 0.65 + 1.5),
		maxf(4.5, float(rig.get("stageDepth", 6)) * 0.6 + 1.2))
	for key in ["trusses", "hangs", "props"]:
		for item in _items(key):
			_include(_position(item))
			if key == "trusses": _include(Vector2(item.endX, item.endZ))


func _include(point: Vector2) -> void:
	extent = extent.max(point.abs() + Vector2(0.7, 0.7))


func _scale() -> float:
	return maxf(0.5, minf((canvas.size.x - 32) / (2 * extent.x), (canvas.size.y - 48) / (2 * extent.y)))


func screen_at(point: Vector2) -> Vector2:
	return canvas.size * 0.5 + point * _scale()


func world_at(pixel: Vector2) -> Vector2:
	return ((pixel - canvas.size * 0.5) / _scale()).snapped(Vector2(0.25, 0.25)).clamp(Vector2(-40, -40), Vector2(40, 40))


func _position(item: Dictionary) -> Vector2:
	return Vector2(item.get("x", 0), item.get("z", 0))


func click_plan(point: Vector2) -> void:
	if tool == 0:
		_select_at(point)
		refresh_form()
		return
	if tool == 1 and first_point == null:
		first_point = point
		hover_point = point
		hint.text = "Click the other end of the truss. Right-click to cancel."
		canvas.queue_redraw()
		return
	var key: String = ["", "trusses", "hangs", "props", "props"][tool]
	if _items(key).size() >= MAX_OBJECTS:
		hint.text = "This plan supports %d %s." % [MAX_OBJECTS, key]
		return
	var item := {"x": point.x, "z": point.y}
	match tool:
		1:
			if first_point.distance_to(point) < 0.5:
				hint.text = "Place the other end at least half a metre away."
				return
			item = {"x": first_point.x, "z": first_point.y, "endX": point.x, "endZ": point.y, "height": 4.0}
		2:
			item.merge({"y": 4.1, "yaw": 0.0, "tilt": 0.0, "count": 4, "splay": 4.0})
		3, 4:
			item.merge({"type": "inflatable" if tool == 3 else "scenic", "height": 2.0})
	var list := _mutable_items(key)
	list.append(item)
	selected = key
	selection = list.size() - 1
	pick_tool(0)
	refresh_form()


func _select_at(point: Vector2) -> void:
	var best := maxf(0.35, 13 / _scale())
	selected = ""
	selection = -1
	for key in ["hangs", "props", "trusses"]:
		var items := _items(key)
		for index in items.size():
			var item: Dictionary = items[index]
			var nearest := _position(item)
			if key == "trusses":
				nearest = Geometry2D.get_closest_point_to_segment(point, nearest, Vector2(item.endX, item.endZ))
			var distance := point.distance_to(nearest)
			if distance < best:
				best = distance
				selected = key
				selection = index


func refresh_form() -> void:
	for child in inspector.get_children():
		inspector.remove_child(child)
		child.queue_free()
	editors.clear()
	counts.text = "Added trusses   %d\nSpeaker hangs   %d\nPlaced props   %d" % [_items("trusses").size(), hangs().size(), _items("props").size()]
	inspector_title.text = "Stage plan"
	canvas.queue_redraw()
	if selection < 0: return
	var item: Dictionary = _items(selected)[selection]
	inspector_title.text = {"trusses":"Truss", "hangs":"Speaker hang", "props":"Stage prop"}[selected] + " %d" % (selection + 1)
	if selected != "trusses":
		_field("X (m)", "x", -40, 40, 0.05, item)
		_field("Z (m)", "z", -40, 40, 0.05, item)
	if selected == "hangs":
		_field("Height (m)", "y", 0.5, 20, 0.05, item)
		_field("Aim (°)", "yaw", -180, 180, 1, item)
		_field("Tilt (°)", "tilt", -90, 90, 1, item)
		_field("Boxes", "count", 1, 16, 1, item)
		_field("Splay (°)", "splay", 0, 15, 0.5, item)
	else:
		_field("Height (m)", "height", 0.25, 20, 0.05, item)
	inspector.add_child(_button("Remove", remove_selected))


func _field(caption: String, key: String, low: float, high: float, step: float, item: Dictionary) -> void:
	var row := HBoxContainer.new()
	var label := Label.new()
	label.text = caption
	label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	row.add_child(label)
	var number := SpinBox.new()
	number.min_value = low
	number.max_value = high
	number.step = step
	number.set_value_no_signal(float(item.get(key, 0)))
	number.value_changed.connect(_set_field.bind(key))
	number.custom_minimum_size.x = 84
	row.add_child(number)
	inspector.add_child(row)
	editors[key] = number


func _set_field(value: float, key: String) -> void:
	if selection < 0: return
	var item: Dictionary = _mutable_items(selected)[selection]
	item[key] = int(value) if key == "count" else value
	_include(_position(item))
	canvas.queue_redraw()


func remove_selected() -> void:
	if selection < 0: return
	_mutable_items(selected).remove_at(selection)
	selected = ""
	selection = -1
	refresh_form()


func draw_plan(view: Control) -> void:
	view.draw_rect(Rect2(Vector2.ZERO, view.size), Color("#141e29"))
	var scale_m := _scale()
	var half := view.size / (2 * scale_m)
	for x in range(-ceili(half.x), ceili(half.x) + 1):
		var sx := screen_at(Vector2(x, 0)).x
		view.draw_line(Vector2(sx, 0), Vector2(sx, view.size.y), Color("#2b3c48"))
	for z in range(-ceili(half.y), ceili(half.y) + 1):
		var sz := screen_at(Vector2(0, z)).y
		view.draw_line(Vector2(0, sz), Vector2(view.size.x, sz), Color("#2b3c48"))
	if not draft.get("replace", false): _draw_source(view)
	for key in ["trusses", "props", "hangs"]:
		var list := _items(key)
		for index in list.size():
			var item: Dictionary = list[index]
			var pos := screen_at(_position(item))
			var active: bool = key == selected and index == selection
			match key:
				"trusses":
					var end := screen_at(Vector2(item.endX, item.endZ))
					view.draw_line(pos, end, ACCENT if active else STEEL, 5, true)
					view.draw_circle(pos, 4, STEEL)
					view.draw_circle(end, 4, STEEL)
					if active or list.size() <= 4:
						var span := pos.distance_to(end) / scale_m
						view.draw_string(ThemeDB.fallback_font, (pos + end) * 0.5 + Vector2(3, -8), "%.2f m" % span, HORIZONTAL_ALIGNMENT_LEFT, -1, 13, STEEL)
				"hangs":
					var aim := Vector2(sin(deg_to_rad(item.get("yaw", 0))), cos(deg_to_rad(item.get("yaw", 0))))
					view.draw_line(pos, pos + aim * 20, HANG, 2, true)
					view.draw_rect(Rect2(pos - Vector2(6, 5), Vector2(12, 10)), HANG)
					if active or list.size() <= 4:
						view.draw_string(ThemeDB.fallback_font, pos + Vector2(9, -13), "Array %d · %d boxes" % [index + 1, item.get("count", 4)], HORIZONTAL_ALIGNMENT_LEFT, -1, 13, HANG)
				"props":
					if item.get("type") == "inflatable":
						view.draw_circle(pos, 7, PROP)
					else:
						view.draw_rect(Rect2(pos - Vector2(6, 6), Vector2(12, 12)), PROP)
					if active or list.size() <= 4:
						var caption := "Inflatable" if item.get("type") == "inflatable" else "Scenery"
						view.draw_string(ThemeDB.fallback_font, pos + Vector2(9, 16), caption, HORIZONTAL_ALIGNMENT_LEFT, -1, 13, PROP)
			if active: view.draw_arc(pos, 11.0, 0, TAU, 24, ACCENT, 2, true)
	if first_point != null: view.draw_dashed_line(screen_at(first_point), screen_at(hover_point), ACCENT, 2.0, 8.0)
	view.draw_string(ThemeDB.fallback_font, Vector2(12, 22), "Upstage", HORIZONTAL_ALIGNMENT_LEFT, -1, 14, MUTED)
	view.draw_string(ThemeDB.fallback_font, Vector2(12, view.size.y - 10), "Audience  ·  1 m grid", HORIZONTAL_ALIGNMENT_LEFT, -1, 14, MUTED)


func _draw_source(view: Control) -> void:
	var decks: Array = rig.get("platforms", [{"width": rig.get("stageWidth", 8), "depth": rig.get("stageDepth", 6)}])
	for deck in decks:
		var offset := Vector2(deck.get("width", 4), deck.get("depth", 3)) * 0.5
		var rect := Rect2(screen_at(_position(deck) - offset), offset * 2 * _scale())
		view.draw_rect(rect, Color("#57717b65"))
		view.draw_rect(rect, Color("#78959c"), false, 1.5)
	for pod in rig.get("trussPods", []):
		var offset := Vector2.RIGHT.rotated(-float(pod.get("rotationY", 0))) * float(pod.get("width", 5)) * 0.5
		view.draw_line(screen_at(_position(pod) - offset), screen_at(_position(pod) + offset), STEEL, 4, true)
	for prop in rig.get("props", []):
		view.draw_circle(screen_at(_position(prop)), 5.0, PROP.darkened(0.25))
