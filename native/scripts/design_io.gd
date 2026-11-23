extends RefCounted

# Keep a media reference beside the saved show without replacing a different file.
static func copy_media(source: String, dest: String) -> String:
	if source==dest: return ""
	if FileAccess.file_exists(dest):
		if FileAccess.get_sha256(source)==FileAccess.get_sha256(dest): return ""
		return "A different file already uses the name "+dest.get_file()+"."
	var read:=FileAccess.open(source,FileAccess.READ)
	if read==null: return "Cannot read "+source.get_file()
	var temp:=dest+".%s.tmp"%OS.get_process_id()
	var written:=FileAccess.open(temp,FileAccess.WRITE)
	if not written: return "Cannot write media in the selected folder."
	while read.get_position()<read.get_length():
		var buf:=read.get_buffer(mini(524288,read.get_length()-read.get_position()))
		if buf.is_empty() or not written.store_buffer(buf):
			written.close()
			DirAccess.remove_absolute(temp)
			return "Could not copy "+dest.get_file()+"."
	written.close()
	if DirAccess.rename_absolute(temp,dest)!=OK:
		DirAccess.remove_absolute(temp)
		return "Cannot finish copying "+dest.get_file()+"."
	return ""

static func referenced_names(document: Dictionary, stage: Dictionary) -> Dictionary:
	var refs: Array=[]
	refs.append(document.get("media",{}))
	refs.append_array(document.get("cues",[]))
	refs.append_array(document.get("timeline",{}).get("events",[]))
	var names: Dictionary={}
	for item in refs:
		for key in ["screen","music"]:
			var value: Dictionary=item.get(key,{})
			if value.get("kind","none") in ["video","file","image"]: names[str(value.name)]=true
	for event in stage.get("screenEvents",[]):
		if event.get("kind") in ["video","image"]: names[str(event.name)]=true
	return names
