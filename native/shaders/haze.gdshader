shader_type spatial;
render_mode unshaded, blend_add, cull_front, depth_draw_never;
uniform vec4 tint : source_color = vec4(1.0);
uniform float strength = 0.2;
void fragment() {
	ALBEDO = tint.rgb;
	ALPHA = strength * (0.3 + 0.7 * pow(max(0.0,1.0 - UV.y),0.8));
}
