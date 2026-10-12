//
//  FieldSpace.metal
//  The living field's atmosphere — one full-field pass. A deep vertical
//  gradient, a soft light well under the constellation, an aurora band
//  breathing along the even line, two parallax layers of star dust, and
//  a gentle vignette. Dark is a night sky; light is a porcelain one.
//  Luminance stays within a few percent of the canvas so every ink pair
//  keeps its contrast contract.
//

#include <metal_stdlib>
using namespace metal;

static float hash21(float2 p) {
    return fract(sin(dot(p, float2(127.1, 311.7))) * 43758.5453);
}

static float vnoise2(float2 p) {
    float2 i = floor(p);
    float2 f = fract(p);
    float2 u = f * f * (3.0 - 2.0 * f);
    float a = mix(hash21(i), hash21(i + float2(1, 0)), u.x);
    float b = mix(hash21(i + float2(0, 1)), hash21(i + float2(1, 1)), u.x);
    return mix(a, b, u.y);
}

static float fbm2(float2 p) {
    float v = 0.0;
    float amp = 0.5;
    for (int k = 0; k < 3; k++) {
        v += amp * vnoise2(p);
        p *= 2.13;
        amp *= 0.5;
    }
    return v;
}

/// One parallax layer of star dust: sparse points on a hash grid, each with
/// its own brightness, size, and twinkle phase.
static float dust(float2 uv, float cells, float time, float drift, float sparsity, float falloff) {
    float2 p = uv * cells + float2(time * drift, 0.0);
    float2 cell = floor(p);
    float2 f = fract(p);
    float h = hash21(cell);
    if (h < sparsity) { return 0.0; }
    float2 starPos = float2(hash21(cell + 17.0), hash21(cell + 31.0));
    float d = length(f - starPos);
    float core = exp(-d * d * falloff);
    float twinkle = 0.7 + 0.3 * sin(time * (0.4 + h) + h * 6.2831);
    return core * pow(h, 7.0) * twinkle;
}

[[ stitchable ]] half4 fieldSpace(
    float2 position,
    half4 currentColor,
    float4 bounds,
    float time,
    float lineY,     // even line, normalized 0…1 of field height
    float dark,
    half4 baseTop,
    half4 baseBottom,
    half4 auroraA,
    half4 auroraB,
    half4 dustC
) {
    float2 uv = (position - bounds.xy) / max(float2(bounds.z, bounds.w), 1.0);

    // The base starts EXACTLY on the canvas color so the field has no
    // visible seam against the headline above; depth builds downward.
    float3 col = mix(float3(baseTop.rgb), float3(baseBottom.rgb),
                     smoothstep(0.06, 1.0, uv.y));

    // Everything atmospheric fades in below the top edge for the same reason.
    float topFade = smoothstep(0.0, 0.14, uv.y);

    // Light well under the constellation — the field has a center of gravity.
    float2 wellCenter = float2(0.5, lineY * 0.82);
    float well = exp(-dot(uv - wellCenter, uv - wellCenter) * 4.2);
    col += float3(auroraA.rgb) * (well * topFade * (dark > 0.5 ? 0.055 : 0.035));

    // Aurora breathing along the even line.
    float band = exp(-pow((uv.y - lineY) * (dark > 0.5 ? 9.0 : 11.0), 2.0));
    float flow = fbm2(float2(uv.x * 3.0 - time * 0.03, time * 0.011));
    float3 aurora = mix(float3(auroraA.rgb), float3(auroraB.rgb),
                        smoothstep(0.25, 0.75, flow));
    col += aurora * (band * topFade * (0.35 + 0.65 * flow) * (dark > 0.5 ? 0.085 : 0.045));

    // Two parallax layers of star dust — finer and faster above, larger
    // and slower below; the light sky keeps only a silver whisper.
    float2 sky = uv * float2(1.0, bounds.w / max(bounds.z, 1.0));
    float stars = dust(sky, 26.0, time, 0.0016, 0.966, 120.0)
                + dust(sky + 5.7, 13.0, time, 0.0034, 0.974, 170.0) * 1.05;
    col += float3(dustC.rgb) * (stars * topFade * float(dustC.a) * (dark > 0.5 ? 1.0 : 0.5));

    // Vignette + fine dither against gradient banding.
    float2 c = uv - 0.5;
    col *= 1.0 - dot(c, c) * (dark > 0.5 ? 0.22 : 0.10);
    col += (hash21(position) - 0.5) * (1.5 / 255.0);

    return half4(half3(clamp(col, 0.0, 1.0)), 1.0);
}
