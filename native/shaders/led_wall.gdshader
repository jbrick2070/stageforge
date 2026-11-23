shader_type spatial;
render_mode unshaded, cull_disabled;
uniform sampler2D video_frame : source_color, hint_default_black, filter_linear, repeat_disable;
uniform float brightness = 0.0;
void fragment() {
	ALBEDO = texture(video_frame, UV).rgb * brightness;
}
