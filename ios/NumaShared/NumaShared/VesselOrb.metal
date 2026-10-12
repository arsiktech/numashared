//
//  VesselOrb.metal
//  The Add vessel's glass body — the app's hero object. Analytic sphere
//  shading in one pass: a milky translucent heart inside a denser limb,
//  a slow interior nebula in the woven hues, fresnel edge light, a key
//  highlight that wanders with the drag pose, and one gleam band that
//  sweeps the glass when a record persists. No scene graph, no textures.
//

#include <metal_stdlib>
using namespace metal;

static float hash3(float3 p) {
    return fract(sin(dot(p, float3(127.1, 311.7, 74.7))) * 43758.5453);
}

static float vnoise(float3 p) {
    float3 i = floor(p);
    float3 f = fract(p);
    float3 u = f * f * (3.0 - 2.0 * f);
    float a = mix(hash3(i + float3(0, 0, 0)), hash3(i + float3(1, 0, 0)), u.x);
    float b = mix(hash3(i + float3(0, 1, 0)), hash3(i + float3(1, 1, 0)), u.x);
    float c = mix(hash3(i + float3(0, 0, 1)), hash3(i + float3(1, 0, 1)), u.x);
    float d = mix(hash3(i + float3(0, 1, 1)), hash3(i + float3(1, 1, 1)), u.x);
    return mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
}

static float fbm(float3 p) {
    float v = 0.0;
    float amp = 0.5;
    for (int k = 0; k < 3; k++) {
        v += amp * vnoise(p);
        p *= 2.03;
        amp *= 0.5;
    }
    return v;
}

[[ stitchable ]] half4 vesselOrb(
    float2 position,
    half4 currentColor,
    float4 bounds,
    float time,
    float yaw,       // radians — drag pose, interior turns with it
    float pitch,
    float engaged,   // 0…1 — pressed/dragging: glass wakes up
    float gleam,     // 0…<1 sweeps once after a save; >= 1 idle
    float dark,
    half4 tintC,
    half4 specA,
    half4 specB,
    half4 rimC
) {
    float R = 0.5 * min(bounds.z, bounds.w);
    float2 uv = (position - bounds.xy - 0.5 * float2(bounds.z, bounds.w)) / R;
    float r2 = dot(uv, uv);
    float edge = 1.0 - smoothstep(1.0 - 2.4 / R, 1.0, r2);
    if (edge <= 0.002) { return half4(0.0); }

    float z = sqrt(max(1.0 - r2, 0.0001));
    float3 n = float3(uv.x, uv.y, z);

    // Interior sampling direction follows the pose — the volume turns while
    // the silhouette stays a perfect circle.
    float cy = cos(yaw), sy = sin(yaw);
    float3 s = float3(n.x * cy + n.z * sy, n.y, -n.x * sy + n.z * cy);
    float cp = cos(pitch), sp = sin(pitch);
    s = float3(s.x, s.y * cp - s.z * sp, s.y * sp + s.z * cp);

    // Milky body: translucent heart, denser limb — the real background
    // composites through the center, which is what makes it read as glass.
    float density = mix(dark > 0.5 ? 0.34 : 0.44, 0.90, pow(1.0 - z, 1.35));
    density = min(density + 0.10 * engaged, 0.95);
    float3 col = float3(tintC.rgb) * density;

    // Slow interior nebula in the woven hues, heavier low in the volume.
    float drift = time * 0.05;
    float f1 = fbm(s * 2.2 + float3(drift, -drift * 0.6, 0.0));
    float f2 = fbm(s * 1.5 + float3(3.1, 7.4, -drift * 0.4));
    float3 swirlTone = mix(float3(specA.rgb), float3(specB.rgb), smoothstep(0.3, 0.7, f2));
    float swirlAmt = (0.13 + 0.10 * engaged + (dark > 0.5 ? 0.03 : 0.0))
        * smoothstep(0.35, 0.80, f1)
        * (0.35 + 0.65 * (0.5 - 0.5 * s.y));
    col += swirlTone * swirlAmt;

    // Fresnel limb as a MIX toward the rim tone: pale glow in dark mode,
    // slate definition against the light canvas — one term, both art
    // directions, no white-on-white edge loss.
    float fres = pow(1.0 - z, 2.8);
    col = mix(col, float3(rimC.rgb), fres * float(rimC.a) * (0.62 + 0.25 * engaged));

    // Key highlight wandering with the pose; a soft counter-glow low down.
    float2 hl = float2(-0.36 + yaw * 0.5, -0.40 + pitch * 0.45);
    col += exp(-dot(uv - hl, uv - hl) * 16.0) * (dark > 0.5 ? 0.55 : 0.72);
    float2 cl = float2(0.14 - yaw * 0.3, 0.50 - pitch * 0.3);
    col += float3(specB.rgb) * (exp(-dot(uv - cl, uv - cl) * 6.0) * 0.16);

    // One gleam band sweeps across after a record persists.
    if (gleam < 1.0) {
        float d = dot(uv, float2(0.766, 0.643)) - (gleam * 2.6 - 1.3);
        col += exp(-d * d * 70.0) * (1.0 - gleam) * 0.5;
    }

    float spec = exp(-dot(uv - hl, uv - hl) * 16.0);
    float alpha = min(density + fres * 0.30 + spec * 0.35, 1.0) * edge;
    return half4(half3(min(col, 1.0) * edge), half(alpha));
}
