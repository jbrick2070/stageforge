"""Install the checksum-pinned native video GDExtension for the Godot project."""
import argparse
import hashlib
import io
from pathlib import Path
import shutil
import urllib.request
import zipfile


VERSION = "v0.4.1"
SHA256 = "667c2b594aa2e60388f7c71db10ec37519ec4043032590762e2c65c3c24ec6e9"
ARCHIVE = f"native_video-{VERSION}.zip"
URL = f"https://github.com/claytercek/godot-native-video/releases/download/{VERSION}/{ARCHIVE}"
ADDONS = Path(__file__).resolve().parents[1] / "addons"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, help="Use a previously downloaded release ZIP")
    args = parser.parse_args()
    if args.archive:
        data = args.archive.read_bytes()
    else:
        with urllib.request.urlopen(URL, timeout=90) as response:
            data = response.read()
    if hashlib.sha256(data).hexdigest() != SHA256:
        raise SystemExit(f"Checksum mismatch for {ARCHIVE}")
    destination = ADDONS / "native_video"
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(data)) as release:
        for item in release.infolist():
            path = Path(item.filename)
            if item.is_dir() or path.parent.as_posix() != "addons/native_video":
                continue
            with release.open(item) as src, (destination / path.name).open("wb") as target:
                shutil.copyfileobj(src, target)
    print(f"Installed godot-native-video {VERSION} into {destination}")


if __name__ == "__main__":
    main()
