use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

const CANONICAL_SHA256: &str = "31535cf7230cd31795c5a4ec6eb5ae64f617fb65e3c7f1f0a0b75432b0990c53";
const APPROVED_MASTER_SHA256: &str =
    "e1bbdb1d238ae6293cb8406da7d39ada6de9293990a40ffa37982679d5dbbb87";
const APPROVED_ICNS_SHA256: &str =
    "e8272c343ece933a76ccec0925fae331a8b59d75213523cb9f2a3da20e9eef86";

struct TestDir(PathBuf);

impl TestDir {
    fn new(label: &str) -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before UNIX epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("{label}-{}-{unique}", std::process::id()));
        fs::create_dir_all(&path).expect("create isolated icon test directory");
        Self(path)
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn repo_path(relative: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(relative)
}

fn sha256(path: &Path) -> String {
    format!(
        "{:x}",
        Sha256::digest(
            fs::read(path)
                .unwrap_or_else(|error| { panic!("read {} for SHA-256: {error}", path.display()) })
        )
    )
}

fn decode_png(path: &Path) -> tauri::image::Image<'static> {
    let bytes = fs::read(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    tauri::image::Image::from_bytes(&bytes)
        .unwrap_or_else(|error| panic!("decode {} as PNG: {error}", path.display()))
        .to_owned()
}

fn pixel(image: &tauri::image::Image<'_>, x: u32, y: u32) -> [u8; 4] {
    let offset = ((y * image.width() + x) * 4) as usize;
    image.rgba()[offset..offset + 4]
        .try_into()
        .expect("RGBA pixel")
}

fn saturated_bbox(
    image: &tauri::image::Image<'_>,
    minimum_alpha: u8,
    minimum_spread: u8,
) -> Option<(u32, u32, u32, u32)> {
    let mut min_x = image.width();
    let mut min_y = image.height();
    let mut max_x = 0;
    let mut max_y = 0;
    let mut found = false;
    for y in 0..image.height() {
        for x in 0..image.width() {
            let rgba = pixel(image, x, y);
            let high = rgba[0].max(rgba[1]).max(rgba[2]);
            let low = rgba[0].min(rgba[1]).min(rgba[2]);
            if rgba[3] >= minimum_alpha && high.saturating_sub(low) >= minimum_spread {
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
                found = true;
            }
        }
    }
    found.then_some((min_x, min_y, max_x, max_y))
}

fn alpha_bbox(image: &tauri::image::Image<'_>, minimum_alpha: u8) -> Option<(u32, u32, u32, u32)> {
    let mut min_x = image.width();
    let mut min_y = image.height();
    let mut max_x = 0;
    let mut max_y = 0;
    let mut found = false;
    for y in 0..image.height() {
        for x in 0..image.width() {
            if pixel(image, x, y)[3] >= minimum_alpha {
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
                found = true;
            }
        }
    }
    found.then_some((min_x, min_y, max_x, max_y))
}

fn fifth_power(value: f64) -> f64 {
    let squared = value * value;
    squared * squared * value
}

fn approved_squircle_alpha(x: u32, y: u32, size: u32) -> u8 {
    const GRID: u32 = 4;
    let center = f64::from(size) / 2.0;
    let half_extent = center;
    let mut covered = 0u32;
    for sample_y in 0..GRID {
        for sample_x in 0..GRID {
            let px = f64::from(x) + (f64::from(sample_x) + 0.5) / f64::from(GRID);
            let py = f64::from(y) + (f64::from(sample_y) + 0.5) / f64::from(GRID);
            let nx = (px - center).abs() / half_extent;
            let ny = (py - center).abs() / half_extent;
            if fifth_power(nx) + fifth_power(ny) <= 1.0 {
                covered += 1;
            }
        }
    }
    ((covered * 255 + (GRID * GRID / 2)) / (GRID * GRID)) as u8
}

#[test]
fn bug_20260729_001_canonical_and_non_target_assets_are_frozen() {
    let assets = [
        (
            "src/assets/logo-crab.png",
            "31535cf7230cd31795c5a4ec6eb5ae64f617fb65e3c7f1f0a0b75432b0990c53",
        ),
        (
            "src-tauri/icons/tray-icon.png",
            "48a2d453ea478492a2649568400964fc53495762bcad836722ecec8711b36b3d",
        ),
        (
            "src-tauri/icons/tray-icon.svg",
            "5bfa528a67f0867ee637503cd4a1a8e2e3a1c208effb4a3d12556518bbd47f2f",
        ),
        (
            "src-tauri/icons/32x32.png",
            "9f1a4e69024ae7055ff275dfe24986acba44370af9f413ded39ca59e823ce257",
        ),
        (
            "src-tauri/icons/128x128.png",
            "5b8214c5ea9abd73e4528bb786e4ac38cb2275066bd12d94db04f30aae803842",
        ),
        (
            "src-tauri/icons/128x128@2x.png",
            "c276ffa66ba64d2d5f07e29489dfed31da4916fab8a82a8718eedf55f8fe7e83",
        ),
        (
            "src-tauri/icons/icon.ico",
            "bbc02bd25b4e6686cb5efd5fc4c9143ba9d6e28fdeab237394bfb54693ba661f",
        ),
    ];

    for (relative, expected) in assets {
        assert_eq!(
            sha256(&repo_path(relative)),
            expected,
            "MAC-DOCK-004 non-target asset drifted: {relative}"
        );
    }
}

#[cfg(target_os = "macos")]
#[test]
fn bug_20260729_001_master_matches_safari_chrome_visual_proportion() {
    let canonical = repo_path("src/assets/logo-crab.png");
    assert_eq!(sha256(&canonical), CANONICAL_SHA256);
    let master_path = repo_path("src-tauri/icons/icon.png");
    assert_eq!(
        sha256(&master_path),
        APPROVED_MASTER_SHA256,
        "MAC-DOCK-001 approved master pixel contract drifted"
    );
    let master = decode_png(&master_path);
    assert_eq!((master.width(), master.height()), (1024, 1024));

    assert_eq!(
        alpha_bbox(&master, 128),
        Some((100, 100, 923, 923)),
        "MAC-DOCK-001 composite must be 824x824 with a 100px transparent safe area"
    );

    for (x, y) in [(0, 0), (1023, 0), (0, 1023), (1023, 1023)] {
        assert_eq!(
            pixel(&master, x, y)[3],
            0,
            "MAC-DOCK-001 Safari-style backplate corner ({x},{y}) must be transparent"
        );
    }

    for (x, y, label) in [
        (0, 512, "canvas left"),
        (1023, 512, "canvas right"),
        (512, 0, "canvas top"),
        (512, 1023, "canvas bottom"),
    ] {
        assert_eq!(
            pixel(&master, x, y)[3],
            0,
            "MAC-DOCK-001 {label} axis endpoint must remain transparent"
        );
    }

    for (x, y, label) in [
        (100, 512, "backplate left"),
        (923, 512, "backplate right"),
        (512, 100, "backplate top"),
        (512, 923, "backplate bottom"),
    ] {
        assert_eq!(
            pixel(&master, x, y),
            [255, 255, 255, 255],
            "MAC-DOCK-001 {label} boundary must be pure opaque white"
        );
    }

    let new_foreground_bbox =
        saturated_bbox(&master, 128, 16).expect("canonical blue/gold foreground must remain");
    assert_eq!(
        new_foreground_bbox,
        (169, 137, 851, 885),
        "MAC-DOCK-001 brand must share the one 80.46875% composite transform"
    );

    let mut intersection = 0u64;
    let mut union = 0u64;
    for y in 0..1024 {
        for x in 0..1024 {
            let inside_composite = (100..=923).contains(&x) && (100..=923).contains(&y);
            if !inside_composite {
                assert_eq!(
                    pixel(&master, x, y)[3],
                    0,
                    "MAC-DOCK-001 100px safe area is not transparent at ({x},{y})"
                );
            }
            let expected_mask =
                inside_composite && approved_squircle_alpha(x - 100, y - 100, 824) >= 128;
            let actual_mask = pixel(&master, x, y)[3] >= 128;
            if expected_mask && actual_mask {
                intersection += 1;
            }
            if expected_mask || actual_mask {
                union += 1;
            }
        }
    }
    let jaccard = intersection as f64 / union as f64;
    assert!(
        jaccard >= 0.995,
        "MAC-DOCK-001 scaled alpha mask is not the approved n=5 curve; Jaccard={jaccard:.6}"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn bug_20260729_001_committed_master_matches_deterministic_generator() {
    let generator = repo_path("scripts/generate-macos-app-icon.swift");
    assert!(
        generator.is_file(),
        "MAC-DOCK-002 deterministic generator is missing: {}",
        generator.display()
    );
    let sandbox = TestDir::new("bug-20260729-001-committed-master");
    let generated_master = sandbox.0.join("generated.png");
    let generated_icns = sandbox.0.join("generated.icns");
    let generation = Command::new("swift")
        .arg(&generator)
        .arg(repo_path("src/assets/logo-crab.png"))
        .arg(&generated_master)
        .arg(&generated_icns)
        .output()
        .expect("run deterministic macOS app-icon generator");
    assert!(
        generation.status.success(),
        "app-icon generation failed: {}",
        String::from_utf8_lossy(&generation.stderr)
    );
    assert_eq!(
        sha256(&generated_master),
        sha256(&repo_path("src-tauri/icons/icon.png")),
        "MAC-DOCK-002 committed master is not the generator output"
    );
    assert_eq!(
        sha256(&generated_icns),
        sha256(&repo_path("src-tauri/icons/icon.icns")),
        "MAC-DOCK-002 committed icon.icns is not the generator output"
    );
}

#[cfg(target_os = "macos")]
fn assert_icns_representation_contract(image: &tauri::image::Image<'_>, name: &str) {
    let width = image.width();
    let height = image.height();
    assert_eq!(width, height, "{name} must stay square");
    for (x, y) in [
        (0, 0),
        (width - 1, 0),
        (0, height - 1),
        (width - 1, height - 1),
        (0, height / 2),
        (width - 1, height / 2),
        (width / 2, 0),
        (width / 2, height - 1),
    ] {
        assert!(
            pixel(image, x, y)[3] <= 8,
            "MAC-DOCK-003 {name} canvas edge ({x},{y}) is not transparent"
        );
    }

    let core_bbox =
        alpha_bbox(image, 128).unwrap_or_else(|| panic!("{name} has no opaque icon core"));
    let core_width = core_bbox.2 - core_bbox.0 + 1;
    let core_height = core_bbox.3 - core_bbox.1 + 1;
    let expected_extent = ((width * 824) + 512) / 1024;
    let quantization_tolerance = if width <= 64 { 2 } else { 1 };
    assert!(
        core_width.abs_diff(expected_extent) <= quantization_tolerance
            && core_height.abs_diff(expected_extent) <= quantization_tolerance,
        "MAC-DOCK-003 {name} core bbox {core_bbox:?} is not the approved 0.8046875 proportion"
    );
    assert!(
        (core_bbox.0 + core_bbox.2).abs_diff(width - 1) <= 1
            && (core_bbox.1 + core_bbox.3).abs_diff(height - 1) <= 1,
        "MAC-DOCK-003 {name} core bbox {core_bbox:?} is not centered"
    );
    if width == 256 {
        assert_eq!(
            core_bbox,
            (25, 25, 230, 230),
            "MAC-DOCK-003 256px core must match Safari/Chrome 206px bbox"
        );
    }

    let has_opaque_white = (core_bbox.1..=core_bbox.3).any(|y| {
        (core_bbox.0..=core_bbox.2).any(|x| {
            let rgba = pixel(image, x, y);
            rgba[3] == 255 && rgba[..3].iter().all(|channel| *channel >= 250)
        })
    });
    assert!(
        has_opaque_white,
        "MAC-DOCK-003 {name} has no truly opaque white backplate sample"
    );

    let foreground_bbox =
        saturated_bbox(image, 96, 12).unwrap_or_else(|| panic!("{name} has no brand foreground"));
    let reference = (169.0, 137.0, 851.0, 885.0);
    let tolerance = (2.0 / f64::from(width)).max(0.01);
    let normalized = (
        f64::from(foreground_bbox.0) / f64::from(width),
        f64::from(foreground_bbox.1) / f64::from(height),
        f64::from(foreground_bbox.2 + 1) / f64::from(width),
        f64::from(foreground_bbox.3 + 1) / f64::from(height),
    );
    let expected = (
        reference.0 / 1024.0,
        reference.1 / 1024.0,
        (reference.2 + 1.0) / 1024.0,
        (reference.3 + 1.0) / 1024.0,
    );
    assert!(
        (normalized.0 - expected.0).abs() <= tolerance
            && (normalized.1 - expected.1).abs() <= tolerance
            && (normalized.2 - expected.2).abs() <= tolerance
            && (normalized.3 - expected.3).abs() <= tolerance,
        "MAC-DOCK-003 {name} foreground bbox {foreground_bbox:?} does not share the master transform"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn bug_20260729_001_icns_has_one_rounded_white_backed_representation_set() {
    assert_eq!(
        sha256(&repo_path("src-tauri/icons/icon.icns")),
        APPROVED_ICNS_SHA256,
        "MAC-DOCK-003 approved ICNS representation set drifted"
    );
    let sandbox = TestDir::new("bug-20260729-001-icns");
    let iconset = sandbox.0.join("icon.iconset");
    let extraction = Command::new("/usr/bin/iconutil")
        .args(["-c", "iconset"])
        .arg(repo_path("src-tauri/icons/icon.icns"))
        .arg("-o")
        .arg(&iconset)
        .output()
        .expect("extract icon.icns");
    assert!(
        extraction.status.success(),
        "iconutil extraction failed: {}",
        String::from_utf8_lossy(&extraction.stderr)
    );

    let expected = [
        "icon_16x16.png",
        "icon_16x16@2x.png",
        "icon_32x32.png",
        "icon_32x32@2x.png",
        "icon_128x128.png",
        "icon_128x128@2x.png",
        "icon_256x256.png",
        "icon_256x256@2x.png",
        "icon_512x512.png",
        "icon_512x512@2x.png",
    ];
    let mut actual: Vec<String> = fs::read_dir(&iconset)
        .expect("read extracted iconset")
        .map(|entry| {
            entry
                .expect("read iconset entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    actual.sort();
    let mut expected_sorted: Vec<String> = expected.iter().map(ToString::to_string).collect();
    expected_sorted.sort();
    assert_eq!(actual, expected_sorted, "MAC-DOCK-003 icns reps drifted");

    for name in expected {
        let image = decode_png(&iconset.join(name));
        assert_icns_representation_contract(&image, name);

        let expected_resample = sandbox.0.join(format!(
            "expected-resample-{}x{}.png",
            image.width(),
            image.height()
        ));
        let resize = Command::new("/usr/bin/sips")
            .args([
                "-z",
                &image.height().to_string(),
                &image.width().to_string(),
            ])
            .arg(repo_path("src-tauri/icons/icon.png"))
            .arg("--out")
            .arg(&expected_resample)
            .output()
            .expect("resample approved master for ICNS oracle");
        assert!(
            resize.status.success(),
            "sips ICNS oracle failed for {name}: {}",
            String::from_utf8_lossy(&resize.stderr)
        );
        let oracle = decode_png(&expected_resample);
        if image.width() <= 32 {
            for (index, (actual, expected)) in image
                .rgba()
                .chunks_exact(4)
                .zip(oracle.rgba().chunks_exact(4))
                .enumerate()
            {
                assert_eq!(
                    actual[3], expected[3],
                    "MAC-DOCK-003 {name} alpha drifted at pixel {index}"
                );
                for channel in 0..3 {
                    let actual_premultiplied =
                        (u16::from(actual[channel]) * u16::from(actual[3]) + 127) / 255;
                    let expected_premultiplied =
                        (u16::from(expected[channel]) * u16::from(expected[3]) + 127) / 255;
                    assert!(
                        actual_premultiplied.abs_diff(expected_premultiplied) <= 16,
                        "MAC-DOCK-003 {name} iconutil legacy 16px premultiplied color conversion exceeded tolerance at pixel {index}: actual={actual:?}, expected={expected:?}"
                    );
                }
            }
        } else {
            assert_eq!(
                image.rgba(),
                oracle.rgba(),
                "MAC-DOCK-003 {name} is not a pixel-exact resample of the one approved master"
            );
        }
    }
}

#[cfg(target_os = "macos")]
#[test]
fn bug_20260729_001_generator_is_reproducible_and_rejects_unapproved_source() {
    let canonical = repo_path("src/assets/logo-crab.png");
    let generator = repo_path("scripts/generate-macos-app-icon.swift");
    assert!(
        generator.is_file(),
        "MAC-DOCK-002 deterministic generator is missing: {}",
        generator.display()
    );

    let sandbox = TestDir::new("bug-20260729-001-generator");
    let first_master = sandbox.0.join("first.png");
    let first_icns = sandbox.0.join("first.icns");
    let second_master = sandbox.0.join("second.png");
    let second_icns = sandbox.0.join("second.icns");

    for (master, icns) in [(&first_master, &first_icns), (&second_master, &second_icns)] {
        let generation = Command::new("swift")
            .arg(&generator)
            .arg(&canonical)
            .arg(master)
            .arg(icns)
            .output()
            .expect("run deterministic macOS app-icon generator");
        assert!(
            generation.status.success(),
            "app-icon generation failed: {}",
            String::from_utf8_lossy(&generation.stderr)
        );
    }

    assert_eq!(
        sha256(&first_master),
        sha256(&second_master),
        "MAC-DOCK-002 repeated master generation is not byte-for-byte deterministic"
    );
    assert_eq!(
        sha256(&first_icns),
        sha256(&second_icns),
        "MAC-DOCK-002 repeated icns generation is not byte-for-byte deterministic"
    );

    let unapproved = sandbox.0.join("same-size-unapproved.png");
    let reencode = Command::new("/usr/bin/sips")
        .args(["-s", "format", "png"])
        .arg(&canonical)
        .arg("--out")
        .arg(&unapproved)
        .output()
        .expect("create same-size unapproved source");
    assert!(
        reencode.status.success(),
        "sips fixture setup failed: {}",
        String::from_utf8_lossy(&reencode.stderr)
    );
    assert_ne!(sha256(&unapproved), CANONICAL_SHA256);

    let protected_master_before = sha256(&first_master);
    let protected_icns_before = sha256(&first_icns);
    let rejected = Command::new("swift")
        .arg(&generator)
        .arg(&unapproved)
        .arg(&first_master)
        .arg(&first_icns)
        .output()
        .expect("run generator with unapproved source");
    assert!(
        !rejected.status.success(),
        "MAC-DOCK-002 generator accepted same-size unapproved canonical input"
    );
    assert_eq!(sha256(&first_master), protected_master_before);
    assert_eq!(sha256(&first_icns), protected_icns_before);
}
