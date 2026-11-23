extends SceneTree

const Desk = preload("res://scripts/main.gd")
var failures := 0


func check(ok: bool, description: String) -> bool:
	if not ok:
		failures += 1
		printerr("FAILED: " + description)
	return ok


func desk_button(app: Node, caption: String) -> Button:
	for child in app.root_ui.find_children("*", "Button", true, false):
		if child.text == caption: return child
	return null


func mount_at(stage: Node, position: Vector3) -> Node3D:
	for child in stage.get_children():
		if child is Node3D and child.position.is_equal_approx(position): return child
	return null


func _initialize() -> void:
	call_deferred("run")


func run() -> void:
	var scratch_root := OS.get_environment("STAGEFORGE_AUTHORING_TEST_DIR")
	if scratch_root.is_empty(): scratch_root = ProjectSettings.globalize_path("user://")
	var scratch := scratch_root.path_join("authoring-%d-%d" % [OS.get_process_id(), Time.get_ticks_usec()])
	var linked := scratch.path_join("video-source")
	var linked_movie := linked.path_join("guest-surface.mp4")
	var save_path := scratch.path_join("independent.stageforge.show.json")
	if not check(DirAccess.make_dir_recursive_absolute(linked) == OK, "create a new test media folder"):
		quit(1)
		return
	var copied: String = preload("res://scripts/design_io.gd").copy_media("res://examples/blue-raster.mp4", linked_movie)
	if not check(copied.is_empty(), "prepare uniquely named local MP4: %s" % copied):
		quit(1)
		return
	var app = Desk.new()
	root.add_child(app)
	await process_frame
	await process_frame
	if not check(app.clock.duration_ms == 16000 and app.stage.heads.size() == 4, "open existing Split Rig at startup: " + app.message.text):
		quit(1)
		return
	var plan := desk_button(app, "Stage plan")
	var wall_button := desk_button(app, "Wall cue")
	if not check(plan != null and wall_button != null, "editor controls on the main desk"):
		quit(1)
		return
	plan.pressed.emit()
	var editor = app.editor
	check(editor.visible, "main Stage plan button opens its editor")
	editor.pick_tool(1)
	editor.click_plan(Vector2(-2, -1))
	editor.click_plan(Vector2(1, 2))
	editor.pick_tool(3)
	editor.click_plan(Vector2(2, 2))
	editor.click_plan(Vector2(4.35, 1))
	editor.editors.x.value = 4.8
	editor.editors.y.value = 4.9
	editor.editors.z.value = 1.7
	editor.editors.yaw.value = -21
	editor.editors.tilt.value = -8
	editor.editors.count.value = 7
	editor.editors.splay.value = 5.5
	editor.apply_layout()
	check(app.dirty and app.clock.stage.layout.hangs.size() == 2, "editor apply reaches live show")
	app.seek_to(6500)
	wall_button.pressed.emit()
	var wall = app.wall_editor
	if not check(wall.visible and wall.ids.has("side-led"), "open actual wall cue editor"):
		quit(1)
		return
	wall.wall.select(wall.ids.find("side-led"))
	wall.refresh_media()
	wall.file_dialog.file_selected.emit(linked_movie)
	wall.transport.selected = 1
	wall.offset.value = 1.75
	wall.confirmed.emit()
	wall.hide()
	app.seek_to(8500)
	check(app.last_snapshot.walls["side-led"].name == "guest-surface.mp4" and not app.last_snapshot.walls["side-led"].authoredPlaying, "editor saves held secondary MP4 at 6500 ms")
	check(is_equal_approx(app.last_snapshot.walls["main-led"].offsetSeconds, 2.0), "main wall unaffected")
	app.save_show(save_path)
	if not check(FileAccess.file_exists(save_path) and not app.dirty, "Save show as writes and clears draft: " + app.message.text):
		quit(1)
		return
	var saved: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(save_path))
	check(saved.version == 3 and saved.stage.layout.trusses.size() == 1 and saved.stage.layout.props[0].type == "inflatable", "v3 includes layout and independent cues")
	check(not FileAccess.file_exists(scratch.path_join("independent.stageforge.stage.json")), "standalone show has no sidecar")
	check(FileAccess.get_sha256(scratch.path_join("guest-surface.mp4")) == FileAccess.get_sha256(linked_movie), "local media copied byte-for-byte adjacent to show")
	check(FileAccess.file_exists(scratch.path_join("amber-clouds.mp4")), "main video copied adjacent to show")
	app.open_show(save_path)
	await process_frame
	check(app.linked_files.is_empty() and app.clock.document.get("version") == 3 and not app.dirty, "reload standalone saved show through normal menu handler")
	var hang := mount_at(app.stage, Vector3(4.8, 4.9, 1.7))
	if check(hang != null and hang.get_child_count() == 7, "reloaded 3D array has authored position and seven cabinets"):
		check(is_equal_approx(hang.rotation_degrees.y, -21) and is_equal_approx(hang.get_child(1).rotation_degrees.x, -5.5), "reloaded 3D aim and splay")
	var truss := mount_at(app.stage, Vector3(-0.5, 4.0, 0.5))
	check(truss != null and is_equal_approx(truss.rotation.y, -PI / 4.0), "diagonal truss transform")
	check(mount_at(app.stage, Vector3(2.0, 1.65, 2.0)) is MeshInstance3D, "inflatable rests on the original deck")
	app.seek_to(8500)
	var snap: Dictionary = app.last_snapshot
	check(snap.cueId == "sweep" and snap.walls["side-led"].startMs == 6500 and snap.walls["side-led"].offsetSeconds == 1.75 and not snap.walls["side-led"].authoredPlaying, "held side wall survives reopen")
	check(snap.walls["main-led"].authoredPlaying and is_equal_approx(snap.walls["main-led"].offsetSeconds, 2.0), "main wall still advances")
	check(app.wall_paths["side-led"] == scratch.path_join("guest-surface.mp4") and app.wall_paths["main-led"] == scratch.path_join("amber-clouds.mp4"), "reopened desk resolves both adjacent media files")
	for head in app.stage.heads:
		var expected := Color("#ffb869") if head.kind == "wash" else Color("#6fbbff")
		check(head.light.light_color.is_equal_approx(expected), "recalled 3D head color " + str(head.kind))
	app.seek_to(12000)
	check(app.last_snapshot.cueId == "scans" and app.stage.laser_materials.size() == 2, "recorded laser cue survives")
	if app.stage.projector_groups.size() == 2:
		for i in 2:
			var mesh = app.stage.projector_groups[i].node.get_node_or_null("Rays")
			if check(mesh != null, "projector mesh after reload"):
				var vertex_count: int = mesh.mesh.surface_get_arrays(0)[Mesh.ARRAY_VERTEX].size()
				check(vertex_count == [5 * 8 * 6, 17 * 96 * 6][i], "individual projector geometry")
	else:
		check(false, "both projectors reloaded")
	app.seek_to(2500)
	check(app.last_snapshot.cueId == "drummer" and app.last_snapshot.walls["side-led"].kind == "none" and app.stage.laser_materials.is_empty(), "reverse jump releases later media and laser look")
	print("Standalone authoring test show: ", save_path)
	app.set_process(false)
	app.music.stop()
	app.music.stream = null
	app.queue_free()
	await process_frame
	# Let the mixing thread finish releasing paused streams before the test process exits.
	await create_timer(0.2).timeout
	if OS.get_environment("STAGEFORGE_AUTHORING_TEST_DIR").is_empty():
		# Only remove the test's own files in its newly created directory.
		for filename in ["independent.stageforge.show.json", "amber-clouds.mp4", "guest-surface.mp4", "blue-raster.mp4"]:
			DirAccess.remove_absolute(scratch.path_join(filename))
		DirAccess.remove_absolute(linked_movie)
		DirAccess.remove_absolute(linked)
		DirAccess.remove_absolute(scratch)
	if failures == 0: print("Native authoring passed: desk to plan to wall cue to standalone v3 with adjacent MP4s.")
	quit(1 if failures > 0 else 0)
