"""Copy shared source examples into the Godot project before importing or exporting it."""
from pathlib import Path
from shutil import copyfile

native = Path(__file__).resolve().parents[1]
source = native.parent / "public" / "examples"
for name in ("split-rig.stageforge.show.json", "amber-clouds.mp4"):
    copyfile(source / name, native / "examples" / name)
