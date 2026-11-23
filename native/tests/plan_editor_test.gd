extends SceneTree

const Editor = preload("res://scripts/plan_editor.gd")
var failures := 0
var applied: Array = []


func check(ok: bool, description: String) -> void:
	if not ok:
		failures += 1
		printerr("FAILED: " + description)


func _initialize() -> void:
	call_deferred("run")


func run() -> void:
	var panel := Editor.new()
	root.add_child(panel)
	var source: Dictionary = JSON.parse_string(FileAccess.get_file_as_string("res://examples/split-rig.stageforge.show.json")).rig
	var original := source.duplicate(true)
	panel.layout_applied.connect(func(layout): applied.append(layout))
	panel.edit(source, {})
	await process_frame
	await process_frame
	check(panel.visible and panel.draft.is_empty(), "opening leaves the source rig authoritative")
	check(panel.hangs().size() == 2, "the imported rig's two hangs are available")
	panel.click_plan(Vector2(4.35, 1.0))
	check(panel.selected == "hangs" and not panel.draft.has("hangs"), "selecting the original right hang preserves its source")
	panel.editors.count.value = 9
	panel.editors.splay.value = 6.5
	panel.editors.yaw.value = -19
	panel.editors.tilt.value = -13
	panel.editors.x.value = 4.5
	panel.editors.y.value = 5.0
	panel.editors.z.value = 1.5
	check(panel.draft.hangs.size() == 2 and panel.draft.hangs[1].count == 9
		and panel.draft.hangs[0].count == 4, "one edited array preserves the other")
	check(panel.draft.hangs[1].splay == 6.5 and panel.draft.hangs[1].yaw == -19
		and panel.draft.hangs[1].tilt == -13 and panel.draft.hangs[1].x == 4.5
		and panel.draft.hangs[1].y == 5.0 and panel.draft.hangs[1].z == 1.5, "all hang controls reach the layout")
	check(not panel.draft.get("replace", false) and source == original, "working on arrays preserves imported lights and source")
	panel.apply_layout()
	check(applied.size() == 1 and not panel.visible, "apply emits a value and closes the panel")
	panel.edit(source, applied[0])
	check(panel.hangs()[1].count == 9, "applied edit reopens")
	panel.blank_layout()
	check(panel.draft.replace and panel.hangs().is_empty(), "blank starts without imported arrays")
	panel.pick_tool(1)
	panel.click_plan(Vector2(-3.0, -1.0))
	panel.click_plan(Vector2(-3.0, -1.0))
	check(panel.draft.trusses.is_empty(), "zero-length truss refused")
	panel.click_plan(Vector2(3.0, -1.0))
	check(panel.draft.trusses.size() == 1 and panel.draft.trusses[0].endX == 3, "two clicks draw truss")
	for tool in [2, 3, 4]:
		panel.pick_tool(tool)
		panel.click_plan(Vector2(-3.25 + 2 * (tool - 2), 1))
	check(panel.hangs().size() == 1 and panel.draft.props.size() == 2, "hang plus both prop kinds")
	panel.pick_tool(0)
	panel.click_plan(Vector2(-3.25, 1.0))
	panel.editors.count.value = 8
	panel.editors.yaw.value = 23
	panel.editors.splay.value = 6
	var arguments := OS.get_cmdline_user_args()
	if arguments.size() == 2 and arguments[0] == "--capture":
		await RenderingServer.frame_post_draw
		await RenderingServer.frame_post_draw
		var image := panel.get_texture().get_image()
		check(image != null and image.save_png(arguments[1]) == OK, "wrote editor screenshot")
	panel.remove_selected()
	check(panel.draft.hangs.is_empty(), "last speaker can be removed")
	panel.restore_layout()
	check(panel.draft.is_empty() and panel.hangs().size() == 2, "source layout can be restored")
	panel.hide()
	check(applied.size() == 1 and applied[0].hangs[1].count == 9, "cancel isolates the draft from the accepted value")
	panel.queue_free()
	await process_frame
	if failures == 0: print("Native plan editor passed: blank floor, endpoints, hangs, aim/splay, props, reload and cancel.")
	quit(1 if failures else 0)
