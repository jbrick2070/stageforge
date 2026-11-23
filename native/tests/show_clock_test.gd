extends SceneTree

const Clock = preload("res://scripts/show_clock.gd")

var failures := 0


func check(condition: bool, description: String) -> void:
	if not condition:
		failures += 1
		printerr("FAILED: " + description)


func _initialize() -> void:
	var clock := Clock.new()
	var error := clock.load_show("res://examples/split-rig.stageforge.show.json", "res://examples/split-rig.stageforge.stage.json")
	if not error.is_empty():
		printerr(error)
		quit(1)
		return
	check(clock.duration_ms == 16000 and clock.cues.size() == 5, "all four cues and the final return to black")
	check(clock.snapshot().blackout, "initial blackout")
	clock.seek(7500)
	var state := clock.snapshot()
	check(state.cueId == "sweep" and state.look.movingGroups.wash.primaryColor == "#ffb869"
		and state.look.movingGroups.beam.primaryColor == "#6fbbff", "distinct lights at cue 3")
	check(state.walls["main-led"].name == "amber-clouds.mp4" and state.walls["main-led"].offsetSeconds == 1.0, "main video clock")
	check(state.walls["side-led"].name == "blue-raster.mp4" and state.walls["side-led"].offsetSeconds == 2.25, "side video independently offset")
	check(state.music.demoStep == 64 and state.music.offsetSeconds == 7.5, "demo clock follows sixteenths")
	check(not state.music.playing and state.music.authoredPlaying, "scrub preserves authored music transport")
	clock.play()
	check(clock.snapshot().walls["main-led"].playing, "resuming runs a cued wall")
	clock.seek(12500)
	state = clock.snapshot()
	check(state.cueId == "scans" and state.walls["main-led"].startMs == 11000, "same clip restarts on the laser cue")
	check(state.walls["main-led"].offsetSeconds == 1.5 and state.walls["main-led"].playing, "main wall moving")
	check(state.walls["side-led"].offsetSeconds == 2.75 and not state.walls["side-led"].playing, "second wall holds")
	check(state.look.laser.beamCount == 5 and state.look.laser.projectors['["cl-front","lasers",2]'].beamCount == 17, "per-projector look restored")
	clock.jump_to_cue(1)
	state = clock.snapshot()
	check(state.cueId == "drummer" and state.music.offsetSeconds == 2.5, "reverse jump rewinds score")
	check(state.walls["side-led"].kind == "none" and not state.look.laser.enabled, "reverse jump removes later wall and laser looks")
	clock.seek(99999)
	state = clock.snapshot()
	check(not clock.playing and state.positionMs == 16000 and state.blackout and not state.music.playing, "terminal blackout and transport stop")
	clock.play()
	check(clock.playing and clock.position_ms == 0 and clock.snapshot().cueId == "dark", "restart after terminal blackout")
	clock.pause()

	var edited := clock.document.duplicate(true)
	edited.timeline.events = [
		{"atMs": 0, "music": {"kind": "demo", "playing": true, "demoStep": 8, "name": "Score"}, "look": {"bpm": 120}},
		{"atMs": 1000, "look": {"bpm": 60}, "volume": 0.5},
		{"atMs": 1000, "volume": 0.2},
		{"atMs": 2400, "music": {"kind": "file", "playing": false, "offsetSeconds": 42.0, "name": "Song.wav"}}
	]
	check(clock.load_documents(edited).is_empty(), "unbundled show loads without secondary wall")
	clock.seek(2000)
	state = clock.snapshot()
	check(state.music.demoStep == 20 and state.music.offsetSeconds == 3.0, "tempo changes integrate score position")
	check(state.volume == 0.2, "same-time events retain file order")
	clock.seek(5000)
	check(clock.snapshot().music.offsetSeconds == 42.0, "user track retains a held seek")

	var bad_side := {"format": "stageforge-native-stage", "version": 1, "walls": [{"id": "side"}],
		"screenEvents": [{"target": "side", "name": "../hidden.mp4", "kind": "video", "playing": false, "atMs": 1}]}
	check(not clock.load_documents(edited, bad_side).is_empty(), "portable local basenames only")
	check(clock.position_ms == 5000, "failed load preserves active transport")
	edited.timeline.events[0].atMs = 1200
	check(not clock.load_documents(edited).is_empty(), "out-of-order show events rejected")
	if failures == 0:
		print("Native show clock passed: split rig replay, two wall seeks, tempo, holds and validation.")
	quit(1 if failures > 0 else 0)
