import * as THREE from 'three';
import { makeFigure } from './originalCrowdGeometry';
import type { SteamboatModelId } from '../data/crowdFilmCast';

/** Original StageForge meshes based on the 1928 film silhouettes. */
export function makeSteamboatMickeyGeometry(wearsCap: boolean = true): THREE.BufferGeometry {
  return makeFigure(add => {
    const black = 0x222222;
    const white = 0xdedede;
    const grey = 0x888888;
    const darkGrey = 0x444444;

    // Torso
    add(new THREE.CylinderGeometry(0.11, 0.14, 0.32, 8, 1, true).translate(0, 0.86, 0), black);

    // Knee shorts / trunks
    add(new THREE.CylinderGeometry(0.155, 0.165, 0.22, 6).scale(1.0, 1.0, 0.9).translate(0, 0.63, 0), grey);

    // Front pair of round buttons
    add(new THREE.CircleGeometry(0.026, 5).rotateY(-0.15).translate(-0.065, 0.65, 0.15), white);
    add(new THREE.CircleGeometry(0.026, 5).rotateY(0.15).translate(0.065, 0.65, 0.15), white);

    // Head sphere
    add(new THREE.SphereGeometry(0.14, 6, 4).scale(1.0, 0.96, 0.96).translate(0, 1.14, 0.01), black);

    // Muzzle / snout
    add(new THREE.ConeGeometry(0.065, 0.12, 6, 1, true).rotateX(Math.PI / 2).translate(0, 1.11, 0.14), grey);
    add(new THREE.ConeGeometry(0.022, 0.035, 4).rotateX(Math.PI / 2).translate(0, 1.11, 0.21), black);

    // Bilateral ears, arms, legs, shoes
    for (const side of [-1, 1]) {
      // Round ear disk
      add(new THREE.CircleGeometry(0.09, 6).rotateY(side * 0.1).translate(side * 0.14, 1.28, -0.02), black);

      add(new THREE.CircleGeometry(0.09, 6).rotateY(Math.PI + side * 0.1).translate(side * 0.14, 1.28, -0.02), black);
      add(new THREE.PlaneGeometry(0.037, 0.066).rotateY(side * 0.30).translate(side * 0.043, 1.164, 0.135), white);
      add(new THREE.PlaneGeometry(0.014, 0.034).rotateY(side * 0.30).translate(side * 0.040, 1.16, 0.1377), black);

      // Bare dark arm
      const arm = new THREE.CylinderGeometry(0.028, 0.024, 0.32, 4, 1, true);
      add(arm.rotateZ(side * 0.22).translate(side * 0.16, 0.84, 0.01), black);

      // Dark bare hand
      add(new THREE.BoxGeometry(0.045, 0.06, 0.04).translate(side * 0.22, 0.66, 0.02), black);

      // Thin pipe leg
      add(new THREE.CylinderGeometry(0.028, 0.025, 0.44, 5, 1, true).translate(side * 0.07, 0.30, 0), black);

      // Oversized rounded shoe
      add(new THREE.BoxGeometry(0.095, 0.08, 0.19).translate(side * 0.08, 0.04, 0.03), darkGrey);
    }

    // Thin curved tail
    add(new THREE.CylinderGeometry(0.012, 0.008, 0.34, 3, 1, true).rotateX(0.6).translate(0, 0.60, -0.16), black);

    // Tall crew cap (wearsCap)
    if (wearsCap) {
      // Crown
      add(new THREE.CylinderGeometry(0.09, 0.11, 0.18, 7).translate(0, 1.34, 0.02), white);
      // Brim / visor
      add(new THREE.BoxGeometry(0.14, 0.02, 0.08).rotateX(0.16).translate(0, 1.25, 0.12), black);
      // Cockade / band patch
      add(new THREE.PlaneGeometry(0.04, 0.05).translate(0, 1.32, 0.124), black);
    }
  });
}

export function makeSteamboatMinnieGeometry(withUkulele: boolean = true): THREE.BufferGeometry {
  return makeFigure(add => {
    const black = 0x222222;
    const white = 0xdcdcdc;
    const skirtGrey = 0x555555;
    const shoeGrey = 0x777777;
    const wood = 0x8a8a8a;

    // Torso
    add(new THREE.CylinderGeometry(0.10, 0.13, 0.30, 6, 1, true).translate(0, 0.85, 0), black);

    // Flared skirt
    add(new THREE.CylinderGeometry(0.11, 0.22, 0.20, 5).translate(0, 0.66, 0), skirtGrey);

    // Bloomers / petticoat trim under skirt
    add(new THREE.CylinderGeometry(0.14, 0.14, 0.06, 5, 1, true).translate(0, 0.54, 0), white);

    // Head sphere
    add(new THREE.SphereGeometry(0.135, 6, 4).scale(1.0, 0.96, 0.96).translate(0, 1.12, 0.01), black);

    // Snout
    add(new THREE.ConeGeometry(0.06, 0.11, 6, 1, true).rotateX(Math.PI / 2).translate(0, 1.10, 0.14), white);
    add(new THREE.ConeGeometry(0.02, 0.03, 4).rotateX(Math.PI / 2).translate(0, 1.10, 0.20), black);

    // Bilateral ears, arms, hands, legs, high-heeled/clog shoes
    for (const side of [-1, 1]) {
      // Round ear disk
      add(new THREE.CircleGeometry(0.085, 6).rotateY(side * 0.1).translate(side * 0.135, 1.27, -0.02), black);

      add(new THREE.CircleGeometry(0.085, 6).rotateY(Math.PI + side * 0.1).translate(side * 0.135, 1.27, -0.02), black);
      add(new THREE.PlaneGeometry(0.036, 0.062).rotateY(side * 0.30).translate(side * 0.041, 1.15, 0.132), white);
      add(new THREE.PlaneGeometry(0.014, 0.032).rotateY(side * 0.30).translate(side * 0.039, 1.146, 0.1345), black);

      // Slender dark bare arm
      const arm = new THREE.CylinderGeometry(0.024, 0.022, 0.30, 4, 1, true);
      const holdsInstrument = withUkulele && side === 1;
      arm.rotateZ(side * 0.18);
      const hand = new THREE.BoxGeometry(0.04, 0.06, 0.035);
      if (holdsInstrument) {
        arm.rotateX(-0.35).translate(0.15, 0.84, 0.058);
        hand.rotateX(0.45).translate(0.164, 0.724, 0.105);
      } else {
        arm.translate(side * 0.15, 0.84, 0.01);
        hand.translate(side * 0.19, 0.677, 0.02);
      }
      add(arm, black);
      add(hand, black);

      // Thin leg
      add(new THREE.CylinderGeometry(0.024, 0.022, 0.52, 3, 1, true).translate(side * 0.065, 0.32, 0), black);

      // Vintage shoe
      add(new THREE.BoxGeometry(0.08, 0.07, 0.17).translate(side * 0.07, 0.035, 0.02), shoeGrey);
    }

    // Early flower pot hat:
    // Flat crown / saucer
    add(new THREE.CylinderGeometry(0.12, 0.13, 0.05, 5).translate(0, 1.27, 0.02), white);
    // Upright wire flower stem
    add(new THREE.CylinderGeometry(0.007, 0.007, 0.16, 3, 1, true).rotateZ(0.12).translate(0.02, 1.37, 0.02), black);
    // Daisy blossom head
    add(new THREE.ConeGeometry(0.045, 0.04, 4).rotateX(-0.2).translate(0.04, 1.46, 0.03), white);

    // Optional 1928 Ukulele accessory
    if (withUkulele) {
      // Body soundbox
      add(new THREE.BoxGeometry(0.11, 0.15, 0.045).rotateZ(0.6).translate(0.10, 0.77, 0.14), wood);
      // Neck
      add(new THREE.BoxGeometry(0.025, 0.18, 0.02).rotateZ(-0.45).translate(0.04, 0.88, 0.15), wood);
      // Soundboard bridge & soundhole face
      add(new THREE.PlaneGeometry(0.05, 0.05).rotateZ(0.6).translate(0.10, 0.77, 0.165), black);
      // Headstock top
      add(new THREE.PlaneGeometry(0.03, 0.04).rotateZ(-0.45).translate(0.079, 0.961, 0.160), white);
    }
  });
}

export function makeSteamboatPeteGeometry(): THREE.BufferGeometry {
  return makeFigure(add => {
    const darkFur = 0x262626;
    const lightPants = 0xcacaca;
    const vestColor = 0x424242;
    const shoeColor = 0x181818;
    const capWhite = 0xeeeeee;
    const capVisor = 0x1f1f1f;

    // Massive upper torso / chest
    add(new THREE.CylinderGeometry(0.25, 0.28, 0.38, 8).scale(1.1, 1.0, 0.88).translate(0, 1.10, 0), vestColor);

    // Bulbous lower belly & hips
    add(new THREE.CylinderGeometry(0.28, 0.24, 0.34, 8).scale(1.15, 1.0, 0.95).translate(0, 0.78, 0.02), lightPants);

    // Thick neck / jowl base
    add(new THREE.CylinderGeometry(0.17, 0.19, 0.12, 6, 1, true).translate(0, 1.32, 0.01), darkFur);

    // Head
    add(new THREE.SphereGeometry(0.18, 7, 5).scale(1.12, 0.95, 1.0).translate(0, 1.45, 0.02), darkFur);

    // Heavy cat muzzle
    add(new THREE.ConeGeometry(0.09, 0.14, 6, 1, true).rotateX(Math.PI / 2).translate(0, 1.42, 0.16), vestColor);
    add(new THREE.BoxGeometry(0.045, 0.03, 0.03).translate(0, 1.42, 0.23), darkFur);

    // Pointed cat ears, broad arms, heavy legs, thick boots
    for (const side of [-1, 1]) {
      // Triangular pointed feline ear
      add(new THREE.ConeGeometry(0.05, 0.11, 3).rotateZ(side * -0.3).translate(side * 0.15, 1.63, 0.01), darkFur);

      add(new THREE.PlaneGeometry(0.042, 0.032).rotateY(side * 0.34).translate(side * 0.070, 1.493, 0.178), capWhite);
      add(new THREE.PlaneGeometry(0.014, 0.024).rotateY(side * 0.34).translate(side * 0.069, 1.492, 0.181), darkFur);

      // Burly upper arm
      const arm = new THREE.CylinderGeometry(0.065, 0.055, 0.40, 4, 1, true);
      add(arm.rotateZ(side * 0.24).translate(side * 0.30, 1.02, 0.02), darkFur);

      // Heavy trouser leg
      add(new THREE.CylinderGeometry(0.105, 0.09, 0.52, 4, 1, true).translate(side * 0.14, 0.36, 0), lightPants);

      // Broad dark shoe
      add(new THREE.BoxGeometry(0.14, 0.11, 0.25).translate(side * 0.14, 0.055, 0.04), shoeColor);
    }

    // Captain's cap
    // Tilted flared crown
    add(new THREE.CylinderGeometry(0.17, 0.14, 0.13, 6).rotateX(-0.1).translate(0, 1.63, 0.03), capWhite);
    // Dark visor / brim
    add(new THREE.BoxGeometry(0.20, 0.025, 0.11).rotateX(0.22).translate(0, 1.57, 0.16), capVisor);
  });
}

export function makeSteamboatParrotGeometry(): THREE.BufferGeometry {
  return makeFigure(add => {
    const white = 0xe0e0e0;
    const bodyGrey = 0x888888;
    const darkWing = 0x505050;
    const black = 0x181818;

    // Perch block / talons base at y=0
    add(new THREE.BoxGeometry(0.18, 0.08, 0.20).translate(0, 0.04, 0), black);

    // Chunky bird legs / talons
    for (const side of [-1, 1]) {
      const leg = new THREE.CylinderGeometry(0.035, 0.03, 0.20, 4);
      add(leg.rotateX(0.15).translate(side * 0.07, 0.16, 0.01), darkWing);
    }

    // Squat perching torso
    const torso = new THREE.CylinderGeometry(0.18, 0.14, 0.44, 6);
    add(torso.rotateX(0.22).translate(0, 0.45, -0.02), bodyGrey);

    // Rounded chest / belly puff
    const belly = new THREE.SphereGeometry(0.19, 6, 4);
    add(belly.scale(0.85, 1.1, 0.95).translate(0, 0.46, 0.06), white);

    // Rounded head
    const head = new THREE.SphereGeometry(0.16, 6, 4);
    add(head.scale(0.9, 1.05, 0.95).translate(0, 0.77, 0.02), bodyGrey);

    // Hooked parrot beak: upper curve and lower mandible
    const upperBill = new THREE.ConeGeometry(0.07, 0.16, 4);
    add(upperBill.rotateX(Math.PI / 2 + 0.35).translate(0, 0.75, 0.17), black);
    const lowerBill = new THREE.ConeGeometry(0.045, 0.09, 4);
    add(lowerBill.rotateX(Math.PI / 2 - 0.1).translate(0, 0.69, 0.14), darkWing);

    // Small black eyes
    for (const side of [-1, 1]) {
      add(new THREE.PlaneGeometry(0.03, 0.03).rotateY(side * 0.45).translate(side * 0.103, 0.81, 0.094), black);
    }

    // Folded wing side planes
    for (const side of [-1, 1]) {
      const wing = new THREE.CylinderGeometry(0.06, 0.02, 0.42, 4);
      add(wing.rotateZ(side * 0.15).rotateX(0.3).translate(side * 0.18, 0.44, -0.04), darkWing);
    }

    // Long, slender dropped tail feather stack
    const tailMain = new THREE.CylinderGeometry(0.07, 0.02, 0.48, 4);
    add(tailMain.rotateX(0.45).translate(0, 0.28, -0.22), darkWing);
    const tailCovert = new THREE.ConeGeometry(0.06, 0.26, 4);
    add(tailCovert.rotateX(-0.40).translate(0, 0.40, -0.17), bodyGrey);
  });
}

export function makeSteamboatCowGeometry(roundBody: boolean): THREE.BufferGeometry {
  return makeFigure(add => {
    const white = 0xeeeeee;
    const grey = 0x888888;
    const darkMuzzle = 0x444444;
    const hornColor = 0x222222;

    const bodyWidth = roundBody ? 0.38 : 0.22;
    const bodyDepth = roundBody ? 0.64 : 0.58;

    // Compact torso
    const torso = new THREE.CylinderGeometry(bodyWidth * 0.85, bodyWidth, bodyDepth, 6);
    add(torso.rotateX(Math.PI / 2).translate(0, 0.84, 0.02), roundBody ? white : grey);

    // Ribcage / flank fullness block
    const flank = new THREE.BoxGeometry(bodyWidth * 1.35, 0.34, bodyDepth * 0.8);
    add(flank.translate(0, 0.85, 0.02), grey);

    // Neck
    const neck = new THREE.CylinderGeometry(0.10, 0.14, 0.28, 4);
    add(neck.rotateX(0.4).translate(0, 0.98, 0.25), white);

    // Head block
    add(new THREE.BoxGeometry(0.18, 0.20, 0.22).translate(0, 1.10, 0.295), white);

    // Recognizable snout / muzzle
    add(new THREE.BoxGeometry(0.19, 0.12, 0.14).translate(0, 1.04, 0.365), darkMuzzle);

    // Upright curved horns
    for (const side of [-1, 1]) {
      const horn = new THREE.ConeGeometry(0.03, 0.17, 4);
      add(horn.rotateZ(side * -0.4).rotateX(-0.2).translate(side * 0.09, 1.25, 0.31), hornColor);
    }

    // Drooping cartoon cow ears
    for (const side of [-1, 1]) {
      const ear = new THREE.ConeGeometry(0.04, 0.14, 3);
      add(ear.rotateZ(side * 1.2).rotateY(side * 0.2).translate(side * 0.15, 1.12, 0.28), grey);
    }

    // Small dock cow bell/tag under throat
    add(new THREE.ConeGeometry(0.05, 0.09, 4).rotateX(Math.PI).translate(0, 0.89, 0.32), hornColor);

    // Four tubular legs + hooves grounded firmly at y=0
    const legX = roundBody ? 0.15 : 0.11;
    const legZOffsets = [0.22, -0.20];
    for (const z of legZOffsets) {
      for (const side of [-1, 1]) {
        // Leg
        const leg = new THREE.CylinderGeometry(0.04, 0.035, 0.64, 4);
        add(leg.translate(side * legX, 0.37, z), white);
        // Hoof
        const hoof = new THREE.BoxGeometry(0.07, 0.08, 0.09);
        add(hoof.translate(side * legX, 0.04, z + 0.01), hornColor);
      }
    }

    // Slender rope tail & tuft
    const tail = new THREE.CylinderGeometry(0.018, 0.014, 0.42, 4);
    add(tail.rotateX(0.25).translate(0, 0.65, -0.32), grey);
    const tuft = new THREE.ConeGeometry(0.038, 0.10, 4);
    add(tuft.rotateX(-0.35).translate(0, 0.43, -0.37), hornColor);
  });
}

export function makeSteamboatGoatGeometry(): THREE.BufferGeometry {
  return makeFigure(add => {
    const white = 0xeeeeee;
    const grey = 0x888888;
    const dark = 0x333333;

    // Torso body cylinder
    const body = new THREE.CylinderGeometry(0.18, 0.20, 0.54, 6);
    add(body.rotateX(Math.PI / 2).translate(0, 0.78, 0.01), grey);

    // Tapered neck
    const neck = new THREE.CylinderGeometry(0.09, 0.13, 0.38, 4);
    add(neck.rotateX(0.55).translate(0, 0.98, 0.22), white);

    // Goat head block
    add(new THREE.BoxGeometry(0.14, 0.16, 0.20).translate(0, 1.15, 0.29), white);

    // Snout / muzzle
    add(new THREE.BoxGeometry(0.12, 0.10, 0.14).translate(0, 1.11, 0.365), dark);

    // Prominent sweeping horns
    for (const side of [-1, 1]) {
      const hornBase = new THREE.CylinderGeometry(0.035, 0.045, 0.22, 4);
      add(hornBase.rotateZ(side * -0.22).rotateX(-0.55).translate(side * 0.06, 1.30, 0.24), dark);
      const hornTip = new THREE.ConeGeometry(0.025, 0.22, 4);
      add(hornTip.rotateZ(side * -0.15).rotateX(-0.95).translate(side * 0.075, 1.41, 0.10), dark);
    }

    // Goatee beard hanging from the chin
    const beard = new THREE.ConeGeometry(0.05, 0.18, 4);
    add(beard.rotateX(Math.PI + 0.15).translate(0, 0.98, 0.38), white);

    // Ears pointing slightly backwards
    for (const side of [-1, 1]) {
      const ear = new THREE.ConeGeometry(0.035, 0.13, 3);
      add(ear.rotateZ(side * 1.3).rotateX(-0.4).translate(side * 0.11, 1.17, 0.26), grey);
    }

    // 4 spindly legs grounded at y=0
    const zOffsets = [0.20, -0.20];
    for (const z of zOffsets) {
      for (const side of [-1, 1]) {
        // Upper & lower thin leg
        const leg = new THREE.CylinderGeometry(0.03, 0.024, 0.68, 4);
        add(leg.translate(side * 0.11, 0.38, z), white);
        // Hoof block
        const hoof = new THREE.BoxGeometry(0.055, 0.07, 0.075);
        add(hoof.translate(side * 0.11, 0.035, z + 0.01), dark);
      }
    }

    // Short upturned cartoon goat tail
    const tail = new THREE.ConeGeometry(0.045, 0.16, 4);
    add(tail.rotateX(-1.1).translate(0, 0.85, -0.28), white);

    // Small black eyes
    for (const side of [-1, 1]) {
      add(new THREE.PlaneGeometry(0.025, 0.025).rotateY(side * 0.4).translate(side * 0.075, 1.19, 0.36), dark);
    }
  });
}

export function makeSteamboatDockBirdGeometry(facingVariant: boolean): THREE.BufferGeometry {
  return makeFigure(add => {
    const white = 0xeeeeee;
    const grey = 0x888888;
    const dark = 0x222222;

    const neckPitch = facingVariant ? 0.35 : 0.15;
    const headY = facingVariant ? 1.38 : 1.48;
    const headZ = facingVariant ? 0.20 : 0.15;
    const beakPitch = facingVariant ? 0.18 : -0.05;

    // Compact rounded oval body
    const body = new THREE.SphereGeometry(0.18, 6, 4);
    add(body.scale(0.85, 0.95, 1.35).translate(0, 0.88, -0.06), grey);

    // Segmented S-curve long neck
    const lowerNeck = new THREE.CylinderGeometry(0.045, 0.055, 0.34, 4);
    add(lowerNeck.rotateX(neckPitch * 0.6).translate(0, 1.05, 0.04), white);
    const upperNeck = new THREE.CylinderGeometry(0.038, 0.045, 0.34, 4);
    add(upperNeck.rotateX(neckPitch * 1.3).translate(0, 1.26, headZ * 0.6), white);

    // Bird head
    const head = new THREE.SphereGeometry(0.10, 6, 3);
    add(head.scale(0.85, 0.95, 1.1).translate(0, headY, headZ), white);

    // Long spear bill
    const bill = new THREE.ConeGeometry(0.035, 0.24, 4);
    add(bill.rotateX(Math.PI / 2 + beakPitch).translate(0, headY - 0.01, headZ + 0.12), dark);

    // Prominent head crest feathers
    const crestAngle = facingVariant ? -0.85 : -0.55;
    const crest = new THREE.ConeGeometry(0.045, 0.24, 4);
    add(crest.rotateX(crestAngle).translate(0, headY + 0.08, headZ - 0.10), dark);

    // Folded wing side accents
    for (const side of [-1, 1]) {
      const wing = new THREE.CylinderGeometry(0.05, 0.02, 0.44, 4);
      add(wing.rotateZ(side * 0.12).rotateX(0.2).translate(side * 0.16, 0.87, -0.07), dark);
    }

    // Long stilt legs + feet grounded at y=0
    for (const side of [-1, 1]) {
      // Stilt leg
      const leg = new THREE.CylinderGeometry(0.022, 0.018, 0.84, 4);
      add(leg.translate(side * 0.075, 0.42, -0.03), dark);
      // Grounded 3-toed webbed foot base at y=0
      const foot = new THREE.BoxGeometry(0.09, 0.03, 0.14);
      add(foot.translate(side * 0.075, 0.015, 0.01), dark);
    }

    // Short pointed tail
    const tail = new THREE.ConeGeometry(0.05, 0.18, 4);
    add(tail.rotateX(-0.8).translate(0, 0.90, -0.26), grey);
  });
}

export function makeSteamboatGalleyCatGeometry(): THREE.BufferGeometry {
  return makeFigure(add => {
    const black = 0x242424;
    const white = 0xe8e8e8;
    const gray = 0x767676;

    // Arched feline body: sloped torso and chest
    add(new THREE.CylinderGeometry(0.11, 0.13, 0.38, 6).rotateX(0.42).translate(0, 0.44, -0.04), black);
    // Upper neck / ruff
    add(new THREE.CylinderGeometry(0.065, 0.08, 0.14, 5).rotateX(-0.18).translate(0, 0.58, 0.10), white);
    // Rounded cat head
    add(new THREE.SphereGeometry(0.11, 6, 4).scale(1.05, 0.95, 0.95).translate(0, 0.68, 0.15), black);
    // Muzzle / cheeks
    add(new THREE.CylinderGeometry(0.04, 0.06, 0.07, 5).scale(1.3, 0.9, 1).rotateX(Math.PI / 2).translate(0, 0.65, 0.24), white);

    // Ears, eyes, and limbs
    for (const side of [-1, 1]) {
      // Pointed upright ears
      const ear = new THREE.ConeGeometry(0.042, 0.11, 3);
      add(ear.rotateZ(side * -0.22).rotateX(-0.1).translate(side * 0.07, 0.79, 0.13), black);

      // Pie-cut / contrast eye planes
      add(new THREE.PlaneGeometry(0.03, 0.04).rotateY(side * 0.32).translate(side * 0.05, 0.70, 0.241), white);
      add(new THREE.PlaneGeometry(0.014, 0.02).rotateX(0.17).rotateY(side * 0.32).translate(side * 0.05, 0.70, 0.2418), black);

      // Front legs & paws
      const foreLeg = new THREE.CylinderGeometry(0.028, 0.025, 0.32, 4, 1, true);
      add(foreLeg.rotateX(-0.25).translate(side * 0.07, 0.20, 0.063), black);
      add(new THREE.BoxGeometry(0.052, 0.042, 0.075).translate(side * 0.07, 0.021, 0.11), white);

      // Rear thighs & paws
      const hindLeg = new THREE.CylinderGeometry(0.045, 0.028, 0.32, 4, 1, true);
      add(hindLeg.rotateX(-0.15).translate(side * 0.08, 0.20, -0.16), black);
      add(new THREE.BoxGeometry(0.054, 0.042, 0.08).translate(side * 0.08, 0.021, -0.14), white);
    }

    // Long, slender curved cat tail (3 segmented cylinders, extending back and curling upward)
    const tailBase = new THREE.CylinderGeometry(0.024, 0.026, 0.18, 4);
    add(tailBase.rotateX(-1.05).translate(0, 0.44, -0.26), black);
    const tailMid = new THREE.CylinderGeometry(0.020, 0.024, 0.18, 4);
    add(tailMid.rotateX(-0.35).translate(0, 0.54, -0.36), black);
    const tailTip = new THREE.CylinderGeometry(0.012, 0.020, 0.14, 4);
    add(tailTip.rotateX(0.45).translate(0, 0.67, -0.34), white);
  });
}

export function makeSteamboatWaterfowlGeometry(): THREE.BufferGeometry {
  return makeFigure(add => {
    const white = 0xeeeeee;
    const beak = 0x828282;
    const dark = 0x222222;

    // Rounded horizontal waterfowl body
    add(new THREE.SphereGeometry(0.16, 6, 4).scale(1.0, 0.9, 1.45).translate(0, 0.40, -0.02), white);
    // Pointed tail plumage
    add(new THREE.ConeGeometry(0.09, 0.16, 4).rotateX(-1.85).translate(0, 0.44, -0.24), white);

    // Extended vertical crane/goose neck
    add(new THREE.CylinderGeometry(0.048, 0.075, 0.36, 5, 1, true).rotateX(0.12).translate(0, 0.62, 0.13), white);
    // Rounded head
    add(new THREE.SphereGeometry(0.085, 6, 4).scale(0.9, 1.05, 1.0).translate(0, 0.82, 0.16), white);

    // Broad, flat forward bill (distinctly wide waterfowl bill gag)
    add(new THREE.BoxGeometry(0.115, 0.034, 0.16).rotateX(0.08).translate(0, 0.795, 0.28), beak);

    for (const side of [-1, 1]) {
      // Cartoon eye spots
      add(new THREE.PlaneGeometry(0.022, 0.032).rotateY(side * 0.42).translate(side * 0.052, 0.84, 0.20), dark);

      // Folded wing flanks
      const wing = new THREE.CylinderGeometry(0.07, 0.02, 0.28, 4).scale(0.3, 1, 1);
      add(wing.rotateX(1.35).rotateZ(side * -0.15).translate(side * 0.14, 0.41, 0.0), white);

      // Legs & broad paddle feet
      const leg = new THREE.CylinderGeometry(0.022, 0.018, 0.28, 4, 1, true);
      add(leg.translate(side * 0.065, 0.165, 0.02), beak);
      // Flat webbed foot
      add(new THREE.BoxGeometry(0.085, 0.028, 0.14).translate(side * 0.065, 0.014, 0.065), beak);
    }
  });
}

export function makeSteamboatSowGeometry(): THREE.BufferGeometry {
  return makeFigure(add => {
    const skin = 0xd4d4d4;
    const snoutColor = 0xa0a0a0;
    const dark = 0x252525;

    // Heavy, low, broad barrel torso
    add(new THREE.CylinderGeometry(0.24, 0.25, 0.62, 7).rotateX(Math.PI / 2).scale(1.18, 1, 0.95).translate(0, 0.42, 0), skin);
    // Rump sphere
    add(new THREE.SphereGeometry(0.25, 6, 4).scale(1.15, 0.95, 0.95).translate(0, 0.42, -0.31), skin);
    // Head / jowl
    add(new THREE.SphereGeometry(0.21, 6, 4).scale(1.05, 0.95, 1.0).translate(0, 0.47, 0.32), skin);
    // Distinctive flat porcine snout disk
    add(new THREE.CylinderGeometry(0.09, 0.095, 0.11, 6).rotateX(Math.PI / 2).translate(0, 0.43, 0.52), snoutColor);

    // Snout nostrils
    for (const side of [-1, 1]) {
      add(new THREE.PlaneGeometry(0.022, 0.028).rotateY(side * 0.10).translate(side * 0.038, 0.43, 0.5754), dark);
      // Eyes
      add(new THREE.PlaneGeometry(0.026, 0.035).rotateY(side * 0.48).translate(side * 0.12, 0.53, 0.44), dark);

      // Short folded ears
      const ear = new THREE.ConeGeometry(0.065, 0.11, 4).scale(1, 0.6, 1);
      add(ear.rotateZ(side * -0.65).rotateX(0.25).translate(side * 0.17, 0.60, 0.30), skin);

      // 4 stout stubby trotters
      const foreLeg = new THREE.CylinderGeometry(0.065, 0.052, 0.22, 5, 1, true);
      add(foreLeg.translate(side * 0.18, 0.14, 0.19), skin);
      add(new THREE.BoxGeometry(0.085, 0.055, 0.095).translate(side * 0.18, 0.0275, 0.20), snoutColor);

      const hindLeg = new THREE.CylinderGeometry(0.072, 0.055, 0.22, 5, 1, true);
      add(hindLeg.translate(side * 0.18, 0.14, -0.20), skin);
      add(new THREE.BoxGeometry(0.088, 0.055, 0.10).translate(side * 0.18, 0.0275, -0.19), snoutColor);
    }

    // Tight curled pig tail (short angled segment + orthogonal curl block, distinctly non-cat/fox)
    const tailStub = new THREE.CylinderGeometry(0.025, 0.028, 0.11, 4);
    add(tailStub.rotateX(-1.1).translate(0, 0.48, -0.54), skin);
    add(new THREE.BoxGeometry(0.045, 0.065, 0.045).translate(0.03, 0.53, -0.58), skin);
  }).scale(1, 1, 0.72);
}

export function makeSteamboatPigletGeometry(lightCoat: boolean): THREE.BufferGeometry {
  return makeFigure(add => {
    const bodyColor = lightCoat ? 0xd0d0d0 : 0x303030;
    const detailColor = lightCoat ? 0x9a9a9a : 0x5a5a5a;
    const darkEye = lightCoat ? 0x202020 : 0xf0f0f0;

    // Small rounded piglet body
    add(new THREE.CylinderGeometry(0.105, 0.115, 0.26, 6).rotateX(Math.PI / 2).translate(0, 0.19, 0), bodyColor);
    add(new THREE.SphereGeometry(0.11, 5, 4).translate(0, 0.19, -0.13), bodyColor);
    // Rounded head
    add(new THREE.SphereGeometry(0.098, 6, 4).translate(0, 0.22, 0.14), bodyColor);
    // Small snout
    add(new THREE.CylinderGeometry(0.042, 0.045, 0.055, 5).rotateX(Math.PI / 2).translate(0, 0.20, 0.245), detailColor);

    for (const side of [-1, 1]) {
      // Tiny eye dot
      add(new THREE.PlaneGeometry(0.016, 0.022).rotateY(side * 0.45).translate(side * 0.052, 0.25, 0.20), darkEye);

      // Short piglet ears
      const ear = new THREE.ConeGeometry(0.035, 0.065, 3);
      add(ear.rotateZ(side * -0.5).rotateX(0.18).translate(side * 0.075, 0.285, 0.12), bodyColor);

      // Small feet
      const frontFoot = new THREE.CylinderGeometry(0.032, 0.028, 0.11, 4, 1, true);
      add(frontFoot.translate(side * 0.078, 0.075, 0.08), bodyColor);
      add(new THREE.BoxGeometry(0.042, 0.034, 0.05).translate(side * 0.078, 0.017, 0.085), detailColor);

      const backFoot = new THREE.CylinderGeometry(0.035, 0.03, 0.11, 4, 1, true);
      add(backFoot.translate(side * 0.078, 0.075, -0.08), bodyColor);
      add(new THREE.BoxGeometry(0.044, 0.034, 0.052).translate(side * 0.078, 0.017, -0.075), detailColor);
    }

    // Mini curled tail
    const miniTail = new THREE.CylinderGeometry(0.014, 0.018, 0.06, 4);
    add(miniTail.rotateX(-1.1).translate(0, 0.23, -0.23), bodyColor);
    add(new THREE.BoxGeometry(0.022, 0.034, 0.022).translate(0.016, 0.25, -0.25), bodyColor);
  });
}

const steamboatFactories = {
  'stageforge-steamboat-1928-mickey-capped': () => makeSteamboatMickeyGeometry(true),
  'stageforge-steamboat-1928-mickey-bare': () => makeSteamboatMickeyGeometry(false),
  'stageforge-steamboat-1928-minnie-with-ukulele': () => makeSteamboatMinnieGeometry(true),
  'stageforge-steamboat-1928-minnie': () => makeSteamboatMinnieGeometry(false),
  'stageforge-steamboat-1928-pete': makeSteamboatPeteGeometry,
  'stageforge-steamboat-1928-parrot': makeSteamboatParrotGeometry,
  'stageforge-steamboat-1928-cow-thin': () => makeSteamboatCowGeometry(false),
  'stageforge-steamboat-1928-cow-round': () => makeSteamboatCowGeometry(true),
  'stageforge-steamboat-1928-goat': makeSteamboatGoatGeometry,
  'stageforge-steamboat-1928-galley-cat': makeSteamboatGalleyCatGeometry,
  'stageforge-steamboat-1928-waterfowl': makeSteamboatWaterfowlGeometry,
  'stageforge-steamboat-1928-sow': makeSteamboatSowGeometry,
  'stageforge-steamboat-1928-piglet-light': () => makeSteamboatPigletGeometry(true),
  'stageforge-steamboat-1928-piglet-dark': () => makeSteamboatPigletGeometry(false),
  'stageforge-steamboat-1928-dock-bird-upright': () => makeSteamboatDockBirdGeometry(false),
  'stageforge-steamboat-1928-dock-bird-leaning': () => makeSteamboatDockBirdGeometry(true),
} satisfies Record<SteamboatModelId, () => THREE.BufferGeometry>;

export function steamboatCrowdGeometry(modelId: SteamboatModelId): THREE.BufferGeometry {
  return steamboatFactories[modelId]();
}
