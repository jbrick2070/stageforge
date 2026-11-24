// Shared world-space haze keeps adjacent fixtures in the same moving air.
const AIR_GLSL = /* glsl */ `
  float hashAir(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }

  float airNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 w = f * f * (3.0 - 2.0 * f);
    return mix(mix(hashAir(i), hashAir(i + vec2(1.0, 0.0)), w.x),
               mix(hashAir(i + vec2(0.0, 1.0)), hashAir(i + 1.0), w.x), w.y);
  }

  float airDensity(vec3 world, float time, float haze) {
    float broad = airNoise(world.xz * 0.19 + world.y * vec2(0.12, -0.18) + vec2(-0.07, 0.04) * time);
    float fine = airNoise(world.xy * vec2(0.66, 0.85) + world.z * 0.31 + vec2(0.09, -0.11) * time);
    return (0.022 + 0.978 * haze) * (0.34 + 1.08 * broad + 0.44 * fine);
  }
`;

export const VOLUMETRIC_BEAM_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;
  varying vec3 vRadial;
  varying vec3 vAxis;
  varying vec4 vCrossAndAzimuth;

  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vRadial = normalize(mat3(modelMatrix) * vec3(normal.x, 0.0, normal.z));
    vAxis = normalize(mat3(modelMatrix) * vec3(0.0, sign(position.y), 0.0));
    vec3 lens = (modelMatrix * vec4(0.0, sign(position.y) * 0.17, 0.0, 1.0)).xyz;
    vec3 across = cross(vAxis, cameraPosition - lens);
    across /= max(length(across), 0.0001);
    vec2 basis = vec2(dot(across, normalize(modelMatrix[0].xyz)), dot(across, normalize(modelMatrix[2].xyz)));
    float azimuth = dot(basis, basis) > 0.0001 ? atan(basis.y, basis.x) : 0.0;
    vCrossAndAzimuth = vec4(across, azimuth);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

export const VOLUMETRIC_BEAM_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity, uHaze, uTime, uPrism, uSoftness, uSeed;
  varying vec2 vUv;
  varying vec3 vWorld;
  varying vec3 vRadial;
  varying vec3 vAxis;
  varying vec4 vCrossAndAzimuth;
  ${AIR_GLSL}

  void main() {
    if (uIntensity < 0.001) discard;
    float reach = clamp(1.0 - vUv.y, 0.0, 1.0);
    vec3 eye = normalize(cameraPosition - vWorld);
    float across = dot(normalize(vRadial), vCrossAndAzimuth.xyz);
    float chord = sqrt(max(0.0, 1.0 - across * across));
    float wash = smoothstep(1.6, 2.4, uSoftness);
    float profile = pow(chord, mix(1.4, 4.2, wash));

    if (uPrism > 0.5) {
      // Project eight angularly separated shafts onto the camera's transverse axis.
      float phase = uTime * 0.48 + uSeed - vCrossAndAzimuth.w;
      float radius = 0.71 * smoothstep(0.0, 0.16, reach);
      float bundle = 0.0;
      for (int k = 0; k < 8; ++k) {
        float offset = across - radius * sin(phase + float(k) * 0.78539816);
        bundle += exp2(-125.0 * offset * offset);
      }
      profile = chord * mix(profile, 0.055 + 0.48 * bundle, smoothstep(0.01, 0.14, reach));
    }

    float endFade = 1.0 - smoothstep(0.69, 1.0, reach);
    float attenuation = endFade / (1.0 + reach * mix(4.2, 8.5, wash));
    float towardEye = max(0.0, dot(eye, vAxis));
    float scatter = 0.85 + 0.62 * towardEye * towardEye;
    float density = airDensity(vWorld, uTime, uHaze);
    float body = mix(0.40, 0.20, wash) * density * attenuation * profile * scatter;
    float lens = 0.30 * exp(-35.0 * reach) * profile * (0.06 + uHaze);
    // AdditiveBlending applies source alpha: supply straight linear RGB once per face.
    gl_FragColor = vec4(uColor, clamp((body + lens) * uIntensity, 0.0, 1.0));
  }
`;

const LASER_GLSL = /* glsl */ `
  uniform vec3 uColorA, uColorB;
  uniform float uColorMode, uIntensity, uHaze, uTime, uBeamCount, uSpeed, uStrobe, uAudioPulse, uSeed;
  varying vec2 vUv;
  varying vec3 vWorld;
  ${AIR_GLSL}

  vec3 laserColor(float position, float t) {
    if (uColorMode > 1.5) {
      float hue = fract(position + t * 0.08 + uSeed * 0.17);
      return clamp(abs(fract(hue + vec3(0.0, 0.666667, 0.333333)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
    }
    if (uColorMode > 0.5) {
      float split = smoothstep(-0.24, 0.24, sin(position * 18.849556 + t * 0.30));
      return mix(uColorA, uColorB, split);
    }
    return uColorA;
  }

  // Box-filter subpixel rays. Averaging a narrow periodic pulse preserves its
  // integrated light at the projector tip and in distant views.
  float integratedRay(float phase, float duty) {
    return floor(phase) * duty + min(fract(phase), duty);
  }

  float rayMask(float phase, float duty) {
    float width = max(fwidth(phase), 0.045);
    float start = phase - 0.5 + 0.5 * duty - 0.5 * width;
    return clamp((integratedRay(start + width, duty) - integratedRay(start, duty)) / width, 0.0, 1.0);
  }

  bool blanked() {
    return uIntensity <= 0.001 ||
      (uStrobe > 0.02 && fract(uTime * (4.0 + uStrobe * 26.0) + uSeed) < 0.45);
  }

  float laserTransmission(float reach) {
    return (1.0 - smoothstep(0.62, 1.0, reach)) / (1.0 + 1.55 * reach);
  }
`;

export const LASER_SHEET_VERT = /* glsl */ `
  uniform float uTime, uPattern, uSpeed, uSpreadX, uSpreadY, uAudioPulse, uSeed;
  varying vec2 vUv;
  varying vec3 vWorld;

  void main() {
    vUv = uv;
    float t = uTime * (0.45 + uSpeed * 2.6);
    float reach = uv.y;
    float x = uv.x * 2.0 - 1.0;
    float width = 0.35 + uSpreadX * 1.50;
    float height = 0.10 + uSpreadY * 4.2;
    vec3 pos = position;
    pos.x *= width;
    // StageEngine supplies a fan in XZ with its aperture at +0.31 Z.
    // Each point of a scanned figure traces a straight ray from that aperture.
    if (uPattern < 0.5) {
      float liquid = 0.64 * sin(3.4 * x + t + uSeed) + 0.18 * sin(7.1 * x - 1.2 * t);
      pos.y += reach * height * liquid;
    } else if (uPattern < 2.5) {
      pos.y += reach * height * x * sin(t * 0.55 + uSeed) * 0.28;
    } else if (uPattern < 3.5) {
      pos.y += reach * height * (1.0 + 0.18 * uAudioPulse) * sin(x * 5.8 + t * 1.6 + uSeed);
    } else if (uPattern < 4.5) {
      pos.y += reach * height * sin(t * 0.7 + uSeed) * 0.32;
    } else if (uPattern < 5.5) {
      float angle = uv.x * 6.2831853 + t * 0.32 + uSeed;
      float radius = 0.60 + 0.36 * cos(5.0 * angle - t * 0.55);
      pos.x = width * (0.07 + reach * 11.0) * cos(angle) * radius;
      pos.y = (0.05 + reach * (2.3 + uSpreadY * 6.8)) * sin(angle) * radius;
    } else {
      pos.y += reach * height * sin(t * 0.86 + uSeed) * 0.15;
    }
    vec4 world = modelMatrix * vec4(pos, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

export const LASER_SHEET_FRAG = /* glsl */ `
  uniform float uPattern;
  ${LASER_GLSL}

  void main() {
    if (blanked()) discard;
    float reach = vUv.y;
    float x = vUv.x;
    float t = uTime * (0.45 + uSpeed * 2.6);
    float phase = x * max(1.0, uBeamCount);
    float rays = rayMask(phase, 0.105);
    float sheet = 0.0;
    if (uPattern < 0.5) {
      sheet = 0.048 + 0.16 * exp(-12.0 * abs(x - 0.5 - 0.47 * sin(t * 0.70 + uSeed)));
      rays *= 0.55;
    } else if (uPattern >= 2.5 && uPattern < 3.5) {
      sheet = 0.045;
    } else if (uPattern >= 3.5 && uPattern < 4.5) {
      rays *= 0.58 + 0.42 * cos(floor(phase) * 1.57 - t * 2.4);
    } else if (uPattern >= 4.5 && uPattern < 5.5) {
      rays *= 0.60 + 0.40 * pow(0.5 + 0.5 * cos(x * 31.416 + t), 2.0);
    } else if (uPattern >= 5.5) {
      float scanner = abs(x - 0.5 - 0.48 * sin(t * 1.5 + uSeed));
      sheet = 0.065 + 0.82 * exp(-50.0 * scanner);
      rays *= 0.23;
    }
    float side = smoothstep(0.0, 0.009, min(x, 1.0 - x));
    float density = airDensity(vWorld, uTime, uHaze);
    float signal = (0.69 * rays + sheet) * side * laserTransmission(reach);
    float glow = 0.20 * exp(-48.0 * reach);
    float alpha = (signal + glow) * density * uIntensity * (1.0 + 0.15 * uAudioPulse);
    gl_FragColor = vec4(laserColor(x, t), clamp(alpha, 0.0, 1.0));
  }
`;

export const LASER_CONE_VERT = /* glsl */ `
  uniform float uTime, uSpeed, uSpreadX, uSpreadY, uAudioPulse, uSeed;
  varying vec2 vUv;
  varying vec3 vWorld;

  void main() {
    vUv = uv;
    vec3 pos = position;
    // The cone already points along +Z. Its circular aperture is in XY.
    float angle = uv.x * 6.2831853;
    float t = uTime * (0.45 + uSpeed * 2.6);
    float reach = 1.0 - uv.y;
    float morph = 1.0 + reach * (0.09 * sin(4.0 * angle + t + uSeed) + 0.08 * uAudioPulse);
    pos.xy *= vec2(0.35 + uSpreadX * 1.30, 0.35 + uSpreadY * 1.30) * morph;
    vec4 world = modelMatrix * vec4(pos, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

export const LASER_CONE_FRAG = /* glsl */ `
  uniform float uRotation;
  ${LASER_GLSL}

  void main() {
    if (blanked()) discard;
    float reach = 1.0 - vUv.y;
    float t = uTime * (0.45 + uSpeed * 2.6);
    float around = vUv.x + uTime * uRotation * 0.09 + uSeed;
    float rays = rayMask(around * max(1.0, uBeamCount), 0.10);
    vec3 rawNormal = cross(dFdx(vWorld), dFdy(vWorld));
    vec3 surfaceNormal = dot(rawNormal, rawNormal) > 1e-10 ? normalize(rawNormal) : vec3(0.0, 1.0, 0.0);
    vec3 toCam = cameraPosition - vWorld;
    vec3 viewDir = dot(toCam, toCam) > 1e-10 ? normalize(toCam) : vec3(0.0, 0.0, 1.0);
    float rim = 1.0 - abs(dot(surfaceNormal, viewDir));
    float sheet = 0.012 + 0.055 * rim * rim * rim;
    float density = airDensity(vWorld, uTime, uHaze);
    float energy = (0.55 * rays + sheet) * laserTransmission(reach) + 0.11 * exp(-45.0 * reach);
    float alpha = energy * density * uIntensity * (1.0 + 0.14 * uAudioPulse);
    gl_FragColor = vec4(laserColor(around, t), clamp(alpha, 0.0, 1.0));
  }
`;

export const LED_WALL_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const LED_WALL_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uMode; // 0=tunnel, 1=cybergrid, 2=spectrum, 3=plasma, 4=strobe_bars, 5=mandala, 6=tour_text, 7=custom
  uniform float uBrightness;
  uniform float uSpeed;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform float uBass;
  uniform float uMid;
  uniform float uHigh;
  uniform float uBeatPulse;
  uniform sampler2D uCustomTex;
  uniform sampler2D uTextTex;
  uniform float uHasCustom;
  uniform float uAspect;
  uniform vec2 uCanvasPixels;
  uniform vec2 uCabinetGrid;
  uniform bool uPixelSnap;

  varying vec2 vUv;

  vec2 mediaUV(vec2 uv, float sourceAspect) {
    float ratio = uAspect / sourceAspect;
    return (uv - 0.5) * vec2(max(ratio, 1.0), max(1.0 / ratio, 1.0)) + 0.5;
  }

  float inFrame(vec2 uv) {
    return step(0.0, min(uv.x, uv.y)) * step(max(uv.x, uv.y), 1.0);
  }

  float stroke(float distanceToCenter, float halfWidth, float pixelWidth) {
    return 1.0 - smoothstep(halfWidth, halfWidth + pixelWidth, abs(distanceToCenter));
  }

  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  void main() {
    if (uBrightness <= 0.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    vec2 uv = vUv;
    vec2 diode = vUv * uCanvasPixels;
    vec2 footprint = fwidth(diode);
    float resolve = 1.0 - smoothstep(0.20, 0.65, max(footprint.x, footprint.y));
    if (uPixelSnap) {
      vec2 center = (clamp(floor(diode), vec2(0.0), uCanvasPixels - 1.0) + 0.5) / uCanvasPixels;
      uv = mix(uv, center, resolve);
    }
    vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
    float t = uTime * (0.4 + uSpeed * 2.2);
    vec3 col = vec3(0.0);

    if (uMode < 0.5) {
      // The scenic wall carries the receding portals. The portrait relay
      // screens pick up their diagonal facets as moving banks of louvers.
      col = vec3(0.0012, 0.0020, 0.0034);
      if (uAspect > 1.25) {
        vec2 q = abs(p * vec2(1.75 / uAspect, 1.92));
        float radius = max(max(q.x, q.y), (q.x + q.y) * 0.68);
        float pixel = max(0.001, fwidth(radius));
        float edge = (1.0 - smoothstep(0.84, 1.01, radius)) * smoothstep(0.09, 0.19, radius);
        for (int gate = 0; gate < 5; ++gate) {
          float depth = fract(float(gate) * 0.2 + t * 0.075);
          float size = 0.085 + 0.98 * depth * depth;
          float fade = smoothstep(0.03, 0.21, depth) * (1.0 - smoothstep(0.86, 1.0, depth));
          float line = stroke(radius - size, 0.003 + 0.005 * depth, pixel);
          float trim = stroke(radius - size * 1.044, 0.0015, pixel) * smoothstep(0.3, 0.7, q.x);
          float corner = smoothstep(0.20 * size, 0.61 * size, min(q.x, q.y));
          vec3 ink = mix(uColorA * 0.81, uColorB * 1.25, corner);
          col += ink * (line + 0.34 * trim) * edge * fade * (0.83 + 0.50 * depth + 0.30 * uBeatPulse);
        }
      } else {
        vec2 q = abs(uv - 0.5);
        float column = smoothstep(0.012, 0.035, q.x) * (1.0 - smoothstep(0.37, 0.46, q.x));
        float slat = (uv.y - q.x * 0.58) * 7.0 - t * 0.24;
        float facet = stroke(fract(slat) - 0.5, 0.058, max(0.01, fwidth(slat)));
        float lit = 0.50 + 0.45 * cos(slat * 0.90 - t * 0.25);
        vec3 bank = mix(uColorA * 0.70, uColorB, smoothstep(0.5, 0.8, lit));
        col += bank * facet * column * (0.60 + 0.5 * lit) * (1.0 - smoothstep(0.39, 0.49, q.y));
      }
    } else if (uMode < 1.5) {
      // 1: Cyber Grid & Horizon Sun
      float horizon = 0.44;
      if (uv.y < horizon) {
        float py = max(0.015, horizon - uv.y);
        float gx = (uv.x - 0.5) / py;
        float gz = 0.55 / py + t * 2.2;
        float lineX = smoothstep(0.92, 0.99, abs(sin(gx * 3.14159)));
        float lineZ = smoothstep(0.9, 0.99, abs(sin(gz * 3.14159)));
        float g = max(lineX, lineZ);
        col = mix(uColorA, uColorB, clamp(py * 2.2, 0.0, 1.0)) * g * (0.85 + uBass * 1.1);
        col += uColorB * 0.12 * (1.0 - py * 2.0);
      } else {
        vec2 sunP = vec2((uv.x - 0.5) * uAspect, uv.y - horizon - 0.15);
        float d = length(sunP);
        float sun = 1.0 - smoothstep(0.29, 0.32 + uBass * 0.05, d);
        float stripes = smoothstep(0.15, 0.35, fract(uv.y * 28.0 - t * 0.3));
        vec3 sunCol = mix(uColorB, uColorA, clamp(uv.y * 1.4, 0.0, 1.0));
        col = sunCol * sun * mix(1.0, stripes, smoothstep(0.45, 0.7, 1.0 - uv.y)) * 1.4;
        col += uColorA * exp(-abs(uv.y - horizon) * 28.0) * (0.9 + uBeatPulse * 0.9);
      }
    } else if (uMode < 2.5) {
      // 2: Arena Audio Spectrum Bars
      float cols = 32.0;
      float idx = floor(uv.x * cols);
      float cellX = fract(uv.x * cols);
      float sym = abs((idx / cols) - 0.5) * 2.0; // symmetric from center
      float wave = 0.28 + 0.32 * sin(sym * 8.0 - t * 4.5) * cos(sym * 3.0 + t * 2.1);
      float barH = clamp(
        mix(uBass, uHigh, sym) * 0.85 + uMid * 0.35 + wave * 0.35 + uBeatPulse * 0.22 * (1.0 - sym),
        0.08,
        0.96
      );
      float distFromCenterY = abs(uv.y - 0.5) * 2.0;
      float inBar = step(distFromCenterY, barH) * smoothstep(0.08, 0.18, min(cellX, 1.0 - cellX));
      float seg = smoothstep(0.12, 0.25, fract(distFromCenterY * 18.0));
      vec3 barCol = mix(uColorA, uColorB, distFromCenterY);
      col = barCol * inBar * seg * 1.35;
      col += uColorA * exp(-distFromCenterY * 14.0) * 0.35;
    } else if (uMode < 3.5) {
      // 3: Liquid Plasma
      vec2 q = p * 2.2;
      float v = sin(q.x * 2.1 + t) + sin(q.y * 2.4 - t * 1.3) + sin((q.x + q.y) * 1.8 + t * 0.8);
      v += sin(length(q * 2.0) - t * 2.1);
      float f = 0.5 + 0.5 * sin(v * 1.6);
      vec3 c1 = mix(uColorA, uColorB, f);
      vec3 c2 = hsv2rgb(vec3(fract(f * 0.35 + t * 0.08), 0.9, 1.0));
      col = mix(c1, c2, 0.32) * (0.65 + 0.65 * pow(f, 2.0)) * (0.85 + uBass * 0.8);
    } else if (uMode < 4.5) {
      // 4: Kinetic Strobe Bars & Chevrons
      float chev = abs(uv.x - 0.5) * 6.0 - uv.y * 2.2 + t * 2.6;
      float band = pow(0.5 + 0.5 * sin(chev * 6.28318), 6.0);
      float beatFlash = uBeatPulse * 1.2;
      vec3 c = mix(uColorA, uColorB, step(0.5, fract(chev * 0.5)));
      col = mix(c * band * 1.4, vec3(1.0), clamp(beatFlash * band * 0.75, 0.0, 0.85));
    } else if (uMode < 5.5) {
      // 5: Sacred Mandala / Kaleidoscope
      float r = length(p);
      float a = atan(p.y, p.x);
      float k = abs(fract(a * 6.0 / 6.28318 + t * 0.12) - 0.5) * 2.0;
      float pat = sin(r * 16.0 - t * 3.0) * cos(k * 9.0 + r * 6.0);
      float glow = smoothstep(0.1, 0.95, abs(pat));
      vec3 c = mix(uColorA, uColorB, 0.5 + 0.5 * sin(r * 5.0 - t * 2.0));
      col = c * glow * (1.0 - r * 0.65) * (0.95 + uMid * 0.9 + uBeatPulse * 0.5);
    } else if (uMode < 6.5) {
      // 6: Tour Typography Wall
      vec2 textUV = mediaUV(uv, 2.0);
      vec4 txt = texture2D(uTextTex, textUV) * inFrame(textUV);
      float bgWave = 0.5 + 0.5 * sin(uv.x * 12.0 + t * 2.2) * cos(uv.y * 6.0 - t * 1.4);
      vec3 bg = mix(uColorA, uColorB, uv.x) * (0.14 + 0.14 * bgWave) * (0.8 + uBass * 0.8);
      vec3 fg = mix(vec3(1.0), mix(uColorA, uColorB, 0.5 + 0.5 * sin(t + uv.x * 4.0)), 0.32) * (1.25 + uBeatPulse * 0.55);
      col = mix(bg, fg, txt.a);
    } else {
      // 7: User-uploaded Image / Video
      if (uHasCustom > 0.5) {
        vec2 size = max(vec2(textureSize(uCustomTex, 0)), vec2(1.0));
        vec2 imageUV = mediaUV(uv, size.x / size.y);
        col = texture2D(uCustomTex, imageUV).rgb * inFrame(imageUV) * (1.05 + uBeatPulse * 0.25);
      } else {
        col = mix(uColorA, uColorB, uv.x) * 0.25;
      }
    }

    // Resolve diodes only when the camera is close enough to see them.
    vec2 dotUv = fract(diode) - 0.5;
    float diodeMask = mix(0.96, 1.03 - 0.22 * smoothstep(0.12, 0.31, dot(dotUv, dotUv)), resolve);
    vec2 cabinet = vUv * uCabinetGrid;
    vec2 seam = abs(fract(cabinet + 0.5) - 0.5);
    vec2 seamWidth = max(fwidth(cabinet), vec2(0.001));
    vec2 gap = (1.0 - smoothstep(vec2(0.003), vec2(0.003) + seamWidth, seam)) * min(vec2(1.0), 0.014 / seamWidth);
    vec3 outRgb = max(col, vec3(0.0)) * diodeMask * (1.0 - 0.20 * max(gap.x, gap.y)) * uBrightness * 0.78;
    gl_FragColor = vec4(outRgb, 1.0);
  }
`;
