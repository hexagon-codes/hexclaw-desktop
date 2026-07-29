//! BUG-20260726-033: the macOS status item must use a dedicated Template Image.
//!
//! This is intentionally an assembly contract. A colorful application/window icon
//! cannot become a correct menu-bar glyph merely by changing its tint at runtime.

mod support;

use std::collections::VecDeque;
#[cfg(target_os = "macos")]
use std::{
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use sha2::{Digest, Sha256};
use support::read_source;

const APPROVED_CANONICAL_SHA256: &str =
    "31535cf7230cd31795c5a4ec6eb5ae64f617fb65e3c7f1f0a0b75432b0990c53";

#[derive(Debug)]
struct TemplateAssetMetrics {
    width: u32,
    height: u32,
    bbox: Option<(u32, u32, u32, u32)>,
    effective_coverage: f64,
    transparent_coverage: f64,
    opaque_coverage: f64,
    center_offset_x: f64,
    center_offset_y: f64,
}

fn template_asset_metrics(image: &tauri::image::Image<'_>) -> TemplateAssetMetrics {
    let width = image.width();
    let height = image.height();
    let rgba = image.rgba();
    let total = usize::try_from(width * height).expect("tray icon dimensions overflow");
    assert_eq!(
        rgba.len(),
        total * 4,
        "decoded tray icon must contain width*height RGBA pixels"
    );

    let mut transparent = 0usize;
    let mut opaque = 0usize;
    let mut effective = 0usize;
    let mut min_x = width;
    let mut min_y = height;
    let mut max_x = 0u32;
    let mut max_y = 0u32;

    for (index, pixel) in rgba.chunks_exact(4).enumerate() {
        let alpha = pixel[3];
        if alpha <= 8 {
            transparent += 1;
        }
        if alpha >= 247 {
            opaque += 1;
        }

        // macOS Template Images consume alpha, but the source asset must remain
        // inspectable as a dark mask rather than an opaque near-white canvas.
        let luminance = (299u32 * u32::from(pixel[0])
            + 587u32 * u32::from(pixel[1])
            + 114u32 * u32::from(pixel[2]))
            / 1000;
        if alpha >= 32 && luminance <= 220 {
            effective += 1;
            let x = u32::try_from(index % usize::try_from(width).unwrap()).unwrap();
            let y = u32::try_from(index / usize::try_from(width).unwrap()).unwrap();
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        }
    }

    let bbox = (effective > 0).then_some((min_x, min_y, max_x, max_y));
    let (center_offset_x, center_offset_y) = bbox.map_or((1.0, 1.0), |(x0, y0, x1, y1)| {
        let bbox_center_x = (f64::from(x0) + f64::from(x1) + 1.0) / 2.0;
        let bbox_center_y = (f64::from(y0) + f64::from(y1) + 1.0) / 2.0;
        (
            (bbox_center_x - f64::from(width) / 2.0).abs() / f64::from(width),
            (bbox_center_y - f64::from(height) / 2.0).abs() / f64::from(height),
        )
    });

    TemplateAssetMetrics {
        width,
        height,
        bbox,
        effective_coverage: effective as f64 / total as f64,
        transparent_coverage: transparent as f64 / total as f64,
        opaque_coverage: opaque as f64 / total as f64,
        center_offset_x,
        center_offset_y,
    }
}

fn pixel_at(image: &tauri::image::Image<'_>, x: u32, y: u32) -> [u8; 4] {
    let width = usize::try_from(image.width()).expect("image width overflow");
    let offset = (usize::try_from(y).expect("pixel y overflow") * width
        + usize::try_from(x).expect("pixel x overflow"))
        * 4;
    let rgba = image.rgba();
    [
        rgba[offset],
        rgba[offset + 1],
        rgba[offset + 2],
        rgba[offset + 3],
    ]
}

fn fill_enclosed_holes(foreground: &[bool], width: u32, height: u32) -> Vec<bool> {
    let width_usize = usize::try_from(width).expect("mask width overflow");
    let height_usize = usize::try_from(height).expect("mask height overflow");
    assert_eq!(foreground.len(), width_usize * height_usize);

    let mut exterior = vec![false; foreground.len()];
    let mut queue = VecDeque::new();
    let mut enqueue = |x: usize, y: usize| {
        let index = y * width_usize + x;
        if !foreground[index] && !exterior[index] {
            exterior[index] = true;
            queue.push_back(index);
        }
    };

    for x in 0..width_usize {
        enqueue(x, 0);
        enqueue(x, height_usize - 1);
    }
    for y in 0..height_usize {
        enqueue(0, y);
        enqueue(width_usize - 1, y);
    }

    while let Some(index) = queue.pop_front() {
        let x = index % width_usize;
        let y = index / width_usize;
        for (next_x, next_y) in [
            x.checked_sub(1).map(|next| (next, y)),
            (x + 1 < width_usize).then_some((x + 1, y)),
            y.checked_sub(1).map(|next| (x, next)),
            (y + 1 < height_usize).then_some((x, y + 1)),
        ]
        .into_iter()
        .flatten()
        {
            let next = next_y * width_usize + next_x;
            if !foreground[next] && !exterior[next] {
                exterior[next] = true;
                queue.push_back(next);
            }
        }
    }

    foreground
        .iter()
        .zip(exterior)
        .map(|(is_foreground, is_exterior)| *is_foreground || !is_exterior)
        .collect()
}

fn canonical_masks_at_tray_size(
    canonical: &tauri::image::Image<'_>,
    tray_width: u32,
    tray_height: u32,
) -> (Vec<bool>, Vec<bool>) {
    let source_width = canonical.width();
    let source_height = canonical.height();
    let source_len = usize::try_from(source_width * source_height).expect("source size overflow");
    let mut crab_seed = Vec::with_capacity(source_len);

    for pixel in canonical.rgba().chunks_exact(4) {
        crab_seed.push(
            pixel[3] >= 48 && i16::from(pixel[0]) - i16::from(pixel[2]) >= 40 && pixel[0] >= 100,
        );
    }
    let crab = fill_enclosed_holes(&crab_seed, source_width, source_height);
    let mut hexagon_at_tray_size =
        Vec::with_capacity(usize::try_from(tray_width * tray_height).expect("tray size overflow"));
    let mut crab_at_tray_size = Vec::with_capacity(hexagon_at_tray_size.capacity());

    for y in 0..tray_height {
        for x in 0..tray_width {
            let source_x = (((u64::from(x) * 2 + 1) * u64::from(source_width))
                / (u64::from(tray_width) * 2))
                .min(u64::from(source_width - 1)) as u32;
            let source_y = (((u64::from(y) * 2 + 1) * u64::from(source_height))
                / (u64::from(tray_height) * 2))
                .min(u64::from(source_height - 1)) as u32;
            let source_index =
                usize::try_from(source_y * source_width + source_x).expect("source index overflow");
            hexagon_at_tray_size.push(pixel_at(canonical, source_x, source_y)[3] >= 48);
            crab_at_tray_size.push(crab[source_index]);
        }
    }

    (hexagon_at_tray_size, crab_at_tray_size)
}

fn erode_mask(mask: &[bool], width: u32, height: u32, radius: i32) -> Vec<bool> {
    let width_i32 = i32::try_from(width).expect("mask width exceeds i32");
    let height_i32 = i32::try_from(height).expect("mask height exceeds i32");
    let mut eroded = vec![false; mask.len()];

    for y in 0..height_i32 {
        for x in 0..width_i32 {
            let index = usize::try_from(y * width_i32 + x).expect("mask index overflow");
            if !mask[index] {
                continue;
            }
            let mut keeps_pixel = true;
            'neighbors: for next_y in y - radius..=y + radius {
                for next_x in x - radius..=x + radius {
                    if next_x < 0
                        || next_y < 0
                        || next_x >= width_i32
                        || next_y >= height_i32
                        || !mask[usize::try_from(next_y * width_i32 + next_x)
                            .expect("neighbor index overflow")]
                    {
                        keeps_pixel = false;
                        break 'neighbors;
                    }
                }
            }
            eroded[index] = keeps_pixel;
        }
    }

    eroded
}

fn alpha_ratio(
    image: &tauri::image::Image<'_>,
    region: &[bool],
    predicate: impl Fn(u8) -> bool,
) -> f64 {
    let mut matches = 0usize;
    let mut samples = 0usize;
    for (pixel, is_sample) in image.rgba().chunks_exact(4).zip(region) {
        if *is_sample {
            samples += 1;
            if predicate(pixel[3]) {
                matches += 1;
            }
        }
    }
    assert!(samples > 0, "canonical alpha region must not be empty");
    matches as f64 / samples as f64
}

fn connected_components(mask: &[bool], width: u32, height: u32) -> usize {
    let width_usize = usize::try_from(width).expect("mask width overflow");
    let height_usize = usize::try_from(height).expect("mask height overflow");
    let mut seen = vec![false; mask.len()];
    let mut components = 0usize;

    for start in 0..mask.len() {
        if !mask[start] || seen[start] {
            continue;
        }
        components += 1;
        seen[start] = true;
        let mut queue = VecDeque::from([start]);
        while let Some(index) = queue.pop_front() {
            let x = index % width_usize;
            let y = index / width_usize;
            for (next_x, next_y) in [
                x.checked_sub(1).map(|next| (next, y)),
                (x + 1 < width_usize).then_some((x + 1, y)),
                y.checked_sub(1).map(|next| (x, next)),
                (y + 1 < height_usize).then_some((x, y + 1)),
            ]
            .into_iter()
            .flatten()
            {
                let next = next_y * width_usize + next_x;
                if mask[next] && !seen[next] {
                    seen[next] = true;
                    queue.push_back(next);
                }
            }
        }
    }

    components
}

#[test]
fn bug_20260726_033_tray_uses_dedicated_template_icon() {
    let tray = read_source("src/tray.rs");
    let mut violations = Vec::new();

    if tray.contains("default_window_icon") {
        violations.push(
            "tray still reuses app.default_window_icon(), which is the colorful blue hexagon",
        );
    }
    if !tray.contains("icon_as_template(true)") {
        violations.push("TrayIconBuilder must opt into macOS Template Image rendering");
    }
    if !(tray.contains("tray-icon.png") || tray.contains("tray-icon.svg")) {
        violations.push("tray must load the dedicated crab tray asset, not the window icon");
    }

    assert!(
        violations.is_empty(),
        "BUG-20260726-033 template icon contract failed:\n  - {}",
        violations.join("\n  - ")
    );
}

#[test]
fn bug_20260726_033_canonical_logo_identity_is_frozen() {
    let canonical = include_bytes!("../../src/assets/logo-crab.png");
    let actual = format!("{:x}", Sha256::digest(canonical));

    assert_eq!(
        actual, APPROVED_CANONICAL_SHA256,
        "MAC-TRAY-001 canonical logo identity drifted"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn bug_20260726_033_generator_rejects_same_size_unapproved_source() {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let canonical = manifest_dir.join("../src/assets/logo-crab.png");
    let generator = manifest_dir.join("../scripts/generate-tray-template-icon.swift");
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before UNIX epoch")
        .as_nanos();
    let sandbox = std::env::temp_dir().join(format!(
        "bug-20260726-033-generator-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir(&sandbox).expect("create isolated generator sandbox");
    let unapproved = sandbox.join("same-size-unapproved.png");
    let output = sandbox.join("tray.png");

    let reencode = Command::new("/usr/bin/sips")
        .args(["-s", "format", "png"])
        .arg(&canonical)
        .arg("--out")
        .arg(&unapproved)
        .output()
        .expect("run sips to re-encode the approved 512x512 source");
    assert!(
        reencode.status.success(),
        "sips fixture setup failed: {}",
        String::from_utf8_lossy(&reencode.stderr)
    );
    let unapproved_digest = format!(
        "{:x}",
        Sha256::digest(fs::read(&unapproved).expect("read re-encoded fixture"))
    );
    assert_ne!(
        unapproved_digest, APPROVED_CANONICAL_SHA256,
        "fixture must retain dimensions while changing frozen file identity"
    );

    let generation = Command::new("swift")
        .arg(&generator)
        .arg(&unapproved)
        .arg(&output)
        .output()
        .expect("run deterministic tray generator");
    let _ = fs::remove_dir_all(&sandbox);

    assert!(
        !generation.status.success(),
        "generator accepted an unapproved same-size canonical source"
    );
}

#[test]
fn bug_20260726_033_tray_asset_is_solid_hexagon_minus_complete_crab_cutout() {
    let canonical =
        tauri::image::Image::from_bytes(include_bytes!("../../src/assets/logo-crab.png"))
            .expect("canonical logo-crab.png must decode as PNG");
    let tray = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))
        .expect("tray-icon.png must decode as PNG");
    assert_eq!(
        (tray.width(), tray.height()),
        (88, 88),
        "the frozen Template Image canvas must remain 88x88"
    );

    let (hexagon, crab) = canonical_masks_at_tray_size(&canonical, tray.width(), tray.height());
    let shell: Vec<bool> = hexagon
        .iter()
        .zip(&crab)
        .map(|(in_hexagon, in_crab)| *in_hexagon && !*in_crab)
        .collect();
    let outside: Vec<bool> = hexagon.iter().map(|in_hexagon| !*in_hexagon).collect();
    let shell_core = erode_mask(&shell, tray.width(), tray.height(), 2);
    let crab_core = erode_mask(&crab, tray.width(), tray.height(), 2);
    let outside_core = erode_mask(&outside, tray.width(), tray.height(), 2);
    let shell_opaque_ratio = alpha_ratio(&tray, &shell_core, |alpha| alpha >= 224);
    let crab_transparent_ratio = alpha_ratio(&tray, &crab_core, |alpha| alpha <= 8);
    let outside_transparent_ratio = alpha_ratio(&tray, &outside_core, |alpha| alpha <= 8);
    let residual_crab_alpha: Vec<bool> = tray
        .rgba()
        .chunks_exact(4)
        .zip(&crab_core)
        .map(|(pixel, in_crab_core)| *in_crab_core && pixel[3] >= 24)
        .collect();
    let residual_crab_alpha_islands =
        connected_components(&residual_crab_alpha, tray.width(), tray.height());
    let mut violations = Vec::new();

    println!(
        "BUG-20260726-033 metrics: shell_opaque_ratio={shell_opaque_ratio:.4}, \
         crab_transparent_ratio={crab_transparent_ratio:.4}, \
         outside_transparent_ratio={outside_transparent_ratio:.4}, \
         residual_crab_alpha_islands={residual_crab_alpha_islands}"
    );

    if shell_opaque_ratio < 0.90 {
        violations.push("canonical hexagon body is not a continuous opaque Template mask");
    }
    if crab_transparent_ratio < 0.90 {
        violations.push("canonical crab silhouette is not cut through to transparency");
    }
    if outside_transparent_ratio < 0.99 {
        violations.push("pixels outside the canonical hexagon are not transparent");
    }
    if residual_crab_alpha_islands != 0 {
        violations.push("crab eyes, mouth, or other positive-alpha islands remain inside cutout");
    }

    assert!(
        violations.is_empty(),
        "BUG-20260726-033 negative-space tray-logo contract failed:\n  - {}\nmetrics: shell_opaque_ratio={shell_opaque_ratio:.4}, crab_transparent_ratio={crab_transparent_ratio:.4}, outside_transparent_ratio={outside_transparent_ratio:.4}, residual_crab_alpha_islands={residual_crab_alpha_islands}",
        violations.join("\n  - "),
    );
}

#[test]
fn bug_20260726_033_tray_asset_is_a_centered_visible_alpha_mask() {
    let image = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))
        .expect("tray-icon.png must decode as PNG");
    let metrics = template_asset_metrics(&image);
    let mut violations = Vec::new();

    if metrics.transparent_coverage < 0.15 {
        violations.push("transparent background covers less than 15% of the canvas");
    }
    if metrics.opaque_coverage > 0.80 {
        violations.push("more than 80% of the canvas is fully opaque");
    }
    if metrics.effective_coverage < 0.16 {
        violations.push("dark alpha-mask coverage is below 16%");
    }

    match metrics.bbox {
        Some((x0, y0, x1, y1)) => {
            let bbox_width = f64::from(x1 - x0 + 1) / f64::from(metrics.width);
            let bbox_height = f64::from(y1 - y0 + 1) / f64::from(metrics.height);
            if bbox_width < 0.55 {
                violations.push("effective contour width is below 55% of the canvas");
            }
            if bbox_height < 0.55 {
                violations.push("effective contour height is below 55% of the canvas");
            }
        }
        None => violations.push("no effective dark alpha-mask pixels were found"),
    }

    if metrics.center_offset_x > 0.08 || metrics.center_offset_y > 0.08 {
        violations.push("effective contour bbox is not centered within 8% of the canvas");
    }

    assert!(
        violations.is_empty(),
        "BUG-20260726-033 tray asset visual contract failed:\n  - {}\nmetrics: canvas={}x{}, bbox={:?}, effective_coverage={:.4}, transparent_coverage={:.4}, opaque_coverage={:.4}, center_offset=({:.4},{:.4})",
        violations.join("\n  - "),
        metrics.width,
        metrics.height,
        metrics.bbox,
        metrics.effective_coverage,
        metrics.transparent_coverage,
        metrics.opaque_coverage,
        metrics.center_offset_x,
        metrics.center_offset_y,
    );
}
