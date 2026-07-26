//! BUG-20260726-033: the macOS status item must use a dedicated Template Image.
//!
//! This is intentionally an assembly contract. A colorful application/window icon
//! cannot become a correct menu-bar glyph merely by changing its tint at runtime.

mod support;

use support::read_source;

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
        let luminance =
            (299u32 * u32::from(pixel[0])
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
