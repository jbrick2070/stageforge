shader_type spatial;
render_mode unshaded, blend_add, cull_disabled, depth_draw_never;
uniform vec4 tint : source_color = vec4(1.0);
uniform float phase = 0.0;
uniform float intensity = 1.0;
void vertex() {
	float d = VERTEX.z;
	VERTEX.y += sin(phase + d * 0.8) * d * 0.045;
	VERTEX.x += sin(phase * 1.3 + d * 0.4) * d * 0.055;
}
void fragment() { ALBEDO = tint.rgb * 2.0; ALPHA = intensity; }
