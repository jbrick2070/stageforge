extends Node3D

# Lengths are metres. Positive Z faces the audience, as in the saved show.
const BLACK := Color("#080b11")
var heads: Array = []
var projector_groups: Array = []
var displays: Dictionary = {}
var focus_marks: Dictionary = {}
var bounds := 8.0
var world := Environment.new()
var work_light: DirectionalLight3D
var camera: Camera3D
var last_laser := ""
var laser_materials: Array = []
var last_rig: Dictionary
var last_sidecar: Dictionary

func solid(color: Color, metallic := 0.0) -> StandardMaterial3D:
	var mat := StandardMaterial3D.new()
	mat.albedo_color = color
	mat.metallic = metallic
	mat.roughness = 0.62
	return mat

func mesh_node(parent: Node3D, mesh: Mesh, mat: Material, at: Vector3) -> MeshInstance3D:
	var node := MeshInstance3D.new()
	node.mesh = mesh
	node.material_override = mat
	node.position = at
	parent.add_child(node)
	return node

func box(parent: Node3D, at: Vector3, size: Vector3, mat: Material) -> MeshInstance3D:
	var mesh := BoxMesh.new()
	mesh.size = size
	return mesh_node(parent, mesh, mat, at)

func rod(parent: Node3D, a: Vector3, b: Vector3, radius: float, mat: Material):
	var length := a.distance_to(b)
	if length < 0.002: return
	var mesh := CylinderMesh.new()
	mesh.radial_segments = 6
	mesh.rings = 0
	mesh.height = length
	mesh.top_radius = radius
	mesh.bottom_radius = radius
	var node := mesh_node(parent, mesh, mat, (a+b)*0.5)
	node.quaternion = Quaternion(Vector3.UP, (b-a).normalized())

func configure(rig: Dictionary, stage: Dictionary):
	for child in get_children():
		remove_child(child)
		child.queue_free()
	heads.clear()
	projector_groups.clear()
	displays.clear()
	focus_marks.clear()
	laser_materials.clear()
	last_laser = ""
	last_rig = rig
	last_sidecar = stage
	var deck_mat := solid(Color("#38404c"))
	var riser_mat := solid(Color("#4c4440"))
	var steel := solid(Color("#a1a9b6"), 0.62)
	var dark := solid(Color("#202631"))
	var grille := solid(Color("#353b45"), 0.3)
	var layout: Dictionary = stage.get("layout",{})
	var blank: bool = layout.get("replace",false)
	var env_node := WorldEnvironment.new()
	world = Environment.new()
	world.background_mode = Environment.BG_COLOR
	world.background_color = BLACK
	world.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	world.ambient_light_color = Color("#bbcae5")
	env_node.environment = world
	add_child(env_node)
	work_light = DirectionalLight3D.new()
	work_light.rotation_degrees = Vector3(-55, -25, 0)
	work_light.light_color = Color("#c5d8ff")
	add_child(work_light)
	bounds = clampf(float(rig.get("stageWidth",8)), 3.0, 40.0)
	var depth := clampf(float(rig.get("stageDepth",6)), 2.0, 32.0)
	box(self, Vector3(0,-0.12,0), Vector3(bounds*4,0.2,depth*5), solid(Color("#161a24")))
	var platforms: Array = [] if blank else rig.get("platforms",[])
	if platforms.is_empty() and not blank: platforms = [{"width":bounds,"depth":depth,"height":0.6}]
	for p in platforms.slice(0,128):
		if not p is Dictionary: continue
		var h := clampf(p.get("height",0.65),0.05,12)
		var center := Vector3(p.get("x",0),h/2,p.get("z",0))
		box(self,center,Vector3(clampf(p.get("width",4),0.1,60), h, clampf(p.get("depth",3),0.1,60)), deck_mat if focus_marks.is_empty() else riser_mat)
		focus_marks["platform:"+str(p.get("id","deck"))] = center + Vector3.UP*h*0.5
	var pods: Array = [] if blank else rig.get("trussPods",[])
	for pod in pods.slice(0,32):
		if pod is Dictionary: build_truss(pod,steel,dark)
	var audio: Dictionary = rig.get("audioRig",{})
	if not blank and not layout.has("hangs") and audio.get("lineArrays",false):
		for sign_x in [-1,1]:
			speaker_hang(Vector3(sign_x*(bounds*0.5+0.35),4.1,1.0),int(audio.get("boxesPerSide",4)),dark,grille)
	for t in layout.get("trusses",[]).slice(0,128):
		var a := Vector2(t.x,t.z)
		var b := Vector2(t.endX,t.endZ)
		var center := (a+b)*0.5
		build_truss({"width":a.distance_to(b),"rotationY":-(b-a).angle(),"baseY":t.height,"x":center.x,"z":center.y},steel,dark)
	for hang in layout.get("hangs",[]).slice(0,64):
		speaker_hang(Vector3(hang.x,hang.y,hang.z),int(hang.count),dark,grille,hang.yaw,hang.tilt,hang.splay)
	for prop in layout.get("props",[]).slice(0,128):
		var deck_y := 0.0
		for platform in platforms:
			if absf(prop.x-platform.get("x",0))<=platform.get("width",4)*0.5 and absf(prop.z-platform.get("z",0))<=platform.get("depth",3)*0.5:
				deck_y=maxf(deck_y,platform.get("height",0.6))
		var h: float=prop.height
		if prop.type=="inflatable":
			var balloon:=SphereMesh.new()
			balloon.radius=h*0.24
			balloon.height=h
			mesh_node(self,balloon,solid(Color("#cd6c9b")),Vector3(prop.x,deck_y+h/2,prop.z))
			box(self,Vector3(prop.x,deck_y+0.08,prop.z),Vector3(0.55,0.16,0.55),dark)
		else:
			box(self,Vector3(prop.x,deck_y+h/2,prop.z),Vector3(0.95,h,0.7),solid(Color("#97634f")))
	var led: Dictionary = rig.get("ledWall",{})
	var wall_configs: Array = stage.get("walls",[])
	if wall_configs.is_empty() and led.get("enabled",false):
		wall_configs = [{"id":"main-led","x":0,"y":2.1,"z":-depth*0.47,"width":led.get("width",4),"height":led.get("height",2)}]
	for wall in wall_configs.slice(0,8):
		if wall is Dictionary: build_wall(wall,dark)
	camera = Camera3D.new()
	add_child(camera)
	var distance := maxf(bounds, depth*1.25)
	camera.position = Vector3(distance*0.22, distance*0.55+0.55, distance*1.5+1.7)
	camera.look_at(Vector3(0,1.9,0),Vector3.UP)
	camera.fov = 39
	camera.current = true

func speaker_hang(point: Vector3, count: int, body: Material, grille: Material, yaw := 0.0, tilt := 0.0, splay := 4.0):
	var mount := Node3D.new()
	mount.position = point
	mount.rotation_degrees=Vector3(tilt,yaw,0)
	add_child(mount)
	var joint:=Vector3.ZERO
	for i in range(clampi(count,1,16)):
		var cab := Node3D.new()
		mount.add_child(cab)
		cab.rotation.x = deg_to_rad(-splay*i)
		cab.position = joint + cab.basis*Vector3(0,-0.15,0)
		joint += cab.basis*Vector3(0,-0.30,0)
		box(cab,Vector3.ZERO,Vector3(0.75,0.27,0.48),body)
		box(cab,Vector3(0,0,0.247),Vector3(0.65,0.205,0.012),grille)
		for k in [-1, 1]:
			box(cab,Vector3(k*0.225,0,0.256),Vector3(0.09,0.13,0.01),body)

func build_truss(pod: Dictionary, steel: Material, housing: Material):
	var mount := Node3D.new()
	add_child(mount)
	mount.position = Vector3(pod.get("x",0),pod.get("baseY",4),pod.get("z",1))
	mount.rotation.y = float(pod.get("rotationY",0))
	var width := clampf(pod.get("width",6),0.5,50.0)
	for z in [-0.14,0.14]:
		for y in [0.0,0.28]:
			rod(mount,Vector3(-width/2,y,z),Vector3(width/2,y,z),0.023,steel)
		var spans := ceili(width/0.42)
		for i in range(spans):
			var a := -width/2+width*i/spans
			var b := -width/2+width*(i+1)/spans
			var high := 0.28 if i%2 else 0.0
			rod(mount,Vector3(a,high,z),Vector3(b,0.28-high,z),0.014,steel)
	var units: Array = []
	var groups: Array = pod.get("fixtures",[])
	for group in groups.slice(0,32):
		if not group is Dictionary: continue
		for i in range(clampi(group.get("count",0),0,32)):
			units.append({"group":group,"unit":i+1})
	for i in range(units.size()):
		var group: Dictionary = units[i].group
		var kind: String = group.get("type","")
		var unit := Node3D.new()
		mount.add_child(unit)
		unit.position = Vector3(width*((i+0.5)/units.size()-0.5),-0.17,0)
		box(unit,Vector3.ZERO,Vector3(0.26,0.2,0.23),housing)
		if kind == "laser":
			projector_groups.append({"node":unit,"key":JSON.stringify([pod.get("id"),group.get("id"),units[i].unit]),"index":units[i].unit})
		elif kind in ["wash","beam"]:
			var light := SpotLight3D.new()
			unit.add_child(light)
			light.spot_range = 24
			light.spot_angle = 22 if kind == "wash" else 8
			var cone := CylinderMesh.new()
			cone.height = 1
			cone.radial_segments = 28
			cone.rings = 0
			cone.top_radius = 0.012
			cone.bottom_radius = 1
			var volume := ShaderMaterial.new()
			volume.shader = preload("res://shaders/haze.gdshader")
			var mesh := mesh_node(unit,cone,volume,Vector3.ZERO)
			mesh.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
			heads.append({"kind":kind,"unit":unit,"light":light,"mesh":mesh,"material":volume,"i":i})

func build_wall(config: Dictionary, housing: Material):
	var id := str(config.get("id",""))
	if id.is_empty() or displays.has(id): return
	var wall := Node3D.new()
	add_child(wall)
	wall.position = Vector3(config.get("x",0),config.get("y",2),config.get("z",-2))
	wall.rotation.y = deg_to_rad(config.get("yaw",0))
	var w := clampf(config.get("width",3),0.2,40)
	var h := clampf(config.get("height",2),0.2,25)
	box(wall,Vector3(0,0,-0.075),Vector3(w+0.10,h+0.10,0.12),housing)
	var screen := QuadMesh.new()
	screen.size = Vector2(w,h)
	var mat := ShaderMaterial.new()
	mat.shader = preload("res://shaders/led_wall.gdshader")
	var surface:=mesh_node(wall,screen,mat,Vector3.ZERO)
	displays[id] = {"material":mat,"texture":RID(),"surface":surface}

func show_frame(id: String, tex: Texture2D, level: float):
	if not displays.has(id): return
	var display: Dictionary=displays[id]
	var mat: ShaderMaterial=display.material
	var rid:=tex.get_rid() if tex!=null else RID()
	if display.texture!=rid:
		display.texture=rid
		RenderingServer.material_set_param(mat.get_rid(),"video_frame",rid if rid.is_valid() else null)
	mat.set_shader_parameter("brightness",level if rid.is_valid() else 0.0)

func apply_look(look: Dictionary, seconds: float):
	var black: bool = look.get("blackout",false)
	var master := 0.0 if black else float(look.get("masterDimmer",1))
	work_light.light_energy = master*0.37
	world.ambient_light_energy = master*0.34
	world.background_color = Color.BLACK if black else BLACK
	var moving: Dictionary = look.get("movingGroups",{})
	for head in heads:
		var kind: String = head.kind
		var group: Dictionary = moving.get(kind,{})
		var level := master*float(look.get(kind+"Intensity",0))
		head.mesh.visible = level>0.001
		head.light.visible = head.mesh.visible
		if not head.mesh.visible: continue
		var tint := Color.from_string(str(group.get("primaryColor",look.get("primaryColor","#d7dbff"))),Color.WHITE)
		var source: Vector3 = head.unit.global_position
		var target: Vector3 = focus_marks.get(group.get("focusMarkId",""),Vector3(0,0.67,0))
		if group.get("movementMode","") == "sweep":
			var phase := seconds*(0.6+float(group.get("movementSpeed",0.3))*1.7)+float(head.i)*1.5
			target = Vector3(sin(phase)*bounds*0.42,0.65,1.4+cos(phase*0.8)*1.1)
		var length := source.distance_to(target)
		if length<=0.05: continue
		head.light.look_at(target,Vector3.FORWARD)
		head.light.light_color = tint
		head.light.light_energy = level*11
		head.mesh.global_position = (source+target)*0.5
		head.mesh.global_basis = Basis(Quaternion(Vector3.DOWN,(target-source).normalized()))
		var radius := length*(0.23 if kind=="wash" else 0.065)
		head.mesh.scale *= Vector3(radius,length,radius)
		head.material.set_shader_parameter("tint",tint)
		head.material.set_shader_parameter("strength",level*(0.14 if kind=="wash" else 0.30))
	var laser: Dictionary = look.get("laser",{})
	var key := JSON.stringify(laser) if master>0.0 and laser.get("enabled",false) else ""
	if key!=last_laser:
		last_laser=key
		build_laser_rays(laser if key!="" else {})
	for mat in laser_materials:
		mat.set_shader_parameter("phase",seconds*(0.35+float(laser.get("speed",0.3))))
		mat.set_shader_parameter("intensity",master*float(laser.get("intensity",0)))

func build_laser_rays(laser: Dictionary):
	laser_materials.clear()
	for projector in projector_groups:
		var node: Node3D = projector.node
		var previous := node.get_node_or_null("Rays")
		if previous:
			node.remove_child(previous)
			previous.queue_free()
		if laser.is_empty(): continue
		var settings := laser.duplicate()
		var overrides: Dictionary = laser.get("projectors",{})
		settings.merge(overrides.get(projector.key,{}),true)
		var count := clampi(settings.get("beamCount",5),1,32)
		var segments := clampi(settings.get("patternSegments",16),4,96)
		var m := ImmediateMesh.new()
		m.surface_begin(Mesh.PRIMITIVE_TRIANGLES)
		for i in range(count):
			var t := TAU*i/count
			var dir := Vector3(cos(t)*float(settings.get("spreadX",0.6)), -0.20+sin(t)*float(settings.get("spreadY",0.3)),1.0)
			for j in range(segments):
				var a := float(j)/segments
				var b := float(j+1)/segments
				var start := dir*a*10
				var end := dir*b*10
				var step := Vector3(0.008,0,0)
				for vertex in [start-step,start+step,end+step,start-step,end+step,end-step]:
					m.surface_add_vertex(vertex)
		m.surface_end()
		var mat := ShaderMaterial.new()
		mat.shader = preload("res://shaders/laser.gdshader")
		mat.set_shader_parameter("tint",Color.from_string(str(settings.get("colorA","#5effb4")),Color.AQUA))
		var rays := mesh_node(node,m,mat,Vector3.ZERO)
		rays.name = "Rays"
		rays.set_meta("beam_count",count)
		rays.set_meta("segments",segments)
		rays.extra_cull_margin = 4.0
		rays.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		laser_materials.append(mat)
