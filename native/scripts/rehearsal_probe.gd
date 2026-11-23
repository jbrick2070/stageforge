extends RefCounted
## Optional packaged-app acceptance probe, invoked with -- --qa-report=<absolute path>.

func observe(app) -> Dictionary:
	var out := {}
	for id in app.walls:
		var adapter = app.walls[id]
		var d: Dictionary = adapter.diagnostics()
		var texture: Texture2D = adapter.texture()
		if texture and texture.get_width()>2:
			var img := texture.get_image()
			if img and not img.is_empty():
				img.resize(8,8,Image.INTERPOLATE_BILINEAR)
				var rgb := Color(0,0,0)
				for x in 8:
					for y in 8: rgb += img.get_pixel(x,y)
				d["rgb"]=[rgb.r/64,rgb.g/64,rgb.b/64]
				d["frameSHA"]=str(img.get_data().hex_encode()).sha256_text()
		out[id]=d
	var look: Dictionary=app.last_snapshot.get("look",{})
	var tints := {}
	for group in app.stage.heads:
		if group.light.visible: tints[group.kind]=group.light.light_color.to_html(false)
	var rays := {}
	for p in app.stage.projector_groups:
		var beam = p.node.get_node_or_null("Rays")
		rays[p.key] = beam!=null and beam.visible
	return {"cue":app.last_snapshot.get("cueId"),"timeMs":app.clock.position_ms,"blackout":look.get("blackout"),
		"walls":out,"musicTarget":app.last_snapshot.music.get("offsetSeconds"),"musicPlayback":app.music.get_playback_position(),
		"lightColors":tints,"projectors":rays}

func delay(app, seconds: float):
	await app.get_tree().create_timer(seconds).timeout

func surface_colors(app,img: Image) -> Dictionary:
	var colors: Dictionary={}
	for id in app.stage.displays:
		var surface: MeshInstance3D=app.stage.displays[id].surface
		var dims: Vector2=surface.mesh.size
		var sum:=Vector3.ZERO
		var count:=0
		for x in range(-3,4):
			for y in range(-3,4):
				var world:=surface.to_global(Vector3(x*dims.x*0.085,y*dims.y*0.085,0))
				var uv:Vector2=app.stage.camera.unproject_position(world)/app.get_viewport().get_visible_rect().size
				if uv.x<0 or uv.y<0 or uv.x>=1 or uv.y>=1: continue
				var c:=img.get_pixel(int(uv.x*img.get_width()),int(uv.y*img.get_height()))
				sum+=Vector3(c.r,c.g,c.b)
				count+=1
		if count>0: colors[id]=[sum.x/count,sum.y/count,sum.z/count]
	return colors

func run(app,path: String):
	var tree: SceneTree=app.get_tree()
	if app.clock.document.is_empty():
		push_error("Acceptance show did not load: "+app.message.text)
		tree.quit(1)
		return
	var window: Window=app.get_window()
	window.content_scale_size=Vector2i(1920,1080)
	window.content_scale_mode=Window.CONTENT_SCALE_MODE_VIEWPORT
	window.content_scale_aspect=Window.CONTENT_SCALE_ASPECT_KEEP
	await RenderingServer.frame_post_draw
	var size := DisplayServer.window_get_size()
	var device := RenderingServer.get_rendering_device()
	var result := {"engine":Engine.get_version_info().string,"gpu":RenderingServer.get_video_adapter_name(),
		"driver":RenderingServer.get_current_rendering_driver_name(),"window":[size.x,size.y],
		"viewport":str(app.get_viewport().get_texture().get_size()),"nativeVideo":ClassDB.class_exists("NativeVideoStream")}
	await delay(app,0.4)
	result["initial"]=observe(app)
	app.seek_to(6900)
	app.toggle_play()
	await delay(app,0.6)
	result["bothStart"]=observe(app)
	var intervals := PackedFloat64Array()
	var start := Time.get_ticks_usec()
	var prev := start
	while Time.get_ticks_usec()-start<2350000:
		await RenderingServer.frame_post_draw
		var now := Time.get_ticks_usec()
		intervals.append((now-prev)/1000.0)
		prev=now
	intervals.sort()
	var late:=0
	for frame in intervals:
		if frame>17: late+=1
	if not intervals.is_empty():
		result["timing"]={"seconds":(prev-start)/1000000.0,"frames":intervals.size(),"meanFps":intervals.size()*1000000.0/(prev-start),
			"medianMs":intervals[intervals.size()/2],"p95Ms":intervals[mini(intervals.size()-1,floori(intervals.size()*0.95))],
			"framesOver17Ms":late}
	result["bothEnd"]=observe(app)
	app.clock.pause()
	app.seek_to(11500)
	await delay(app,0.6)
	result["finale"]=observe(app)
	var finale_image:Image=app.get_viewport().get_texture().get_image()
	finale_image.save_png(path.get_basename()+"-finale.png")
	result["surfaceColors"]=surface_colors(app,finale_image)
	app.seek_to(7200)
	await delay(app,0.6)
	result["backward"]=observe(app)
	app.seek_to(15500)
	app.toggle_play()
	await delay(app,0.85)
	result["end"]=observe(app)
	var checks:Dictionary={"render1080":finale_image.get_size()==Vector2i(1920,1080),
		"blackout":result.initial.blackout and result.end.blackout and result.end.lightColors.is_empty(),
		"cueSeek":result.backward.cue=="sweep" and result.finale.cue=="scans",
		"audioSeek":absf(float(result.backward.musicPlayback)-7.2)<0.15}
	for id in ["main-led","side-led"]:
		var first:Dictionary=result.bothStart.walls.get(id,{})
		var last:Dictionary=result.bothEnd.walls.get(id,{})
		checks[id+"Playback"]=last.get("position",0)>first.get("position",0)+1.5 and first.has("frameSHA") and last.has("frameSHA")
		var target:=0.7 if id=="main-led" else 1.95
		checks[id+"Seek"]=absf(float(result.backward.walls.get(id,{}).get("position",-1))-target)<0.18
	var primary:Array=result.surfaceColors.get("main-led",[0,0,0])
	var side:Array=result.surfaceColors.get("side-led",[0,0,0])
	checks["distinctSurfaces"]=Vector3(primary[0],primary[1],primary[2]).distance_to(Vector3(side[0],side[1],side[2]))>0.08
	result["checks"]=checks
	var output := FileAccess.open(path,FileAccess.WRITE)
	if output!=null:
		output.store_string(JSON.stringify(result,"  "))
		output.close()
	tree.quit(0 if output!=null and device!=null and not checks.values().has(false) else 1)
