#!/usr/bin/env swift

import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

private let canvasSize = 1024
private let dockCompositeSize = 824
private let dockSafeArea = (canvasSize - dockCompositeSize) / 2
private let coverageGrid = 4
private let approvedCanonicalSHA256 =
    "31535cf7230cd31795c5a4ec6eb5ae64f617fb65e3c7f1f0a0b75432b0990c53"
private let approvedForegroundPixelSHA256 =
    "771ee5909122b235b407fdf035f4722a7828ea96d5a8c4f4ef5e93d249d9ec34"

private func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("macOS app icon generation failed: \(message)\n".utf8))
    exit(1)
}

private func sha256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func verifyCanonicalIdentity(at url: URL) {
    guard let data = try? Data(contentsOf: url) else {
        fail("cannot read \(url.path)")
    }
    let actual = sha256(data)
    guard actual == approvedCanonicalSHA256 else {
        fail("canonical logo SHA-256 must remain \(approvedCanonicalSHA256), got \(actual)")
    }
}

@discardableResult
private func run(_ executable: String, _ arguments: [String]) -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr
    do {
        try process.run()
    } catch {
        fail("cannot run \(executable): \(error)")
    }
    process.waitUntilExit()
    let output = String(
        data: stdout.fileHandleForReading.readDataToEndOfFile(),
        encoding: .utf8
    ) ?? ""
    let error = String(
        data: stderr.fileHandleForReading.readDataToEndOfFile(),
        encoding: .utf8
    ) ?? ""
    guard process.terminationStatus == 0 else {
        fail("\(executable) exited \(process.terminationStatus): \(error)")
    }
    return output
}

private func loadPremultipliedRGBA(
    from url: URL,
    expectedWidth: Int,
    expectedHeight: Int
) -> [UInt8] {
    guard
        let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        fail("cannot decode \(url.path)")
    }
    guard image.width == expectedWidth, image.height == expectedHeight else {
        fail(
            "\(url.lastPathComponent) must be \(expectedWidth)x\(expectedHeight), got \(image.width)x\(image.height)"
        )
    }

    var pixels = [UInt8](repeating: 0, count: expectedWidth * expectedHeight * 4)
    guard
        let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
        let context = CGContext(
            data: &pixels,
            width: expectedWidth,
            height: expectedHeight,
            bitsPerComponent: 8,
            bytesPerRow: expectedWidth * 4,
            space: colorSpace,
            bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue
                | CGImageAlphaInfo.premultipliedLast.rawValue
        )
    else {
        fail("cannot allocate sRGB RGBA context")
    }
    context.interpolationQuality = .none
    context.draw(
        image,
        in: CGRect(x: 0, y: 0, width: expectedWidth, height: expectedHeight)
    )
    return pixels
}

private func fifthPower(_ value: Double) -> Double {
    let squared = value * value
    return squared * squared * value
}

private let normalizedSubpixelFifthPowers: [Double] = {
    let center = Double(canvasSize) / 2.0
    let halfExtent = center
    return (0..<(canvasSize * coverageGrid)).map { subpixel in
        let coordinate =
            (Double(subpixel) + 0.5) / Double(coverageGrid)
        return fifthPower(abs(coordinate - center) / halfExtent)
    }
}()

private let allowedSubpixelXBounds: [(lower: Int, upper: Int)?] = {
    let count = canvasSize * coverageGrid
    let leftHalfEnd = count / 2
    return normalizedSubpixelFifthPowers.map { yPower in
        var low = 0
        var high = leftHalfEnd
        while low < high {
            let middle = (low + high) / 2
            if normalizedSubpixelFifthPowers[middle] + yPower <= 1.0 {
                high = middle
            } else {
                low = middle + 1
            }
        }
        guard
            low < leftHalfEnd,
            normalizedSubpixelFifthPowers[low] + yPower <= 1.0
        else {
            return nil
        }
        return (lower: low, upper: count - 1 - low)
    }
}()

private func squircleAlpha(x: Int, y: Int) -> UInt8 {
    var covered = 0
    let pixelFirstSubpixel = x * coverageGrid
    let pixelLastSubpixel = pixelFirstSubpixel + coverageGrid - 1
    for sampleY in 0..<coverageGrid {
        guard let bounds = allowedSubpixelXBounds[y * coverageGrid + sampleY] else {
            continue
        }
        let first = max(pixelFirstSubpixel, bounds.lower)
        let last = min(pixelLastSubpixel, bounds.upper)
        if first <= last {
            covered += last - first + 1
        }
    }
    let samples = coverageGrid * coverageGrid
    return UInt8((covered * 255 + samples / 2) / samples)
}

private func composeWhiteSquircle(behind foreground: [UInt8]) -> [UInt8] {
    var output = [UInt8](repeating: 0, count: foreground.count)
    var clippedForegroundPixels = 0

    for y in 0..<canvasSize {
        for x in 0..<canvasSize {
            let offset = (y * canvasSize + x) * 4
            let sourceAlpha = Int(foreground[offset + 3])
            let backgroundAlpha = Int(squircleAlpha(x: x, y: y))
            if sourceAlpha > 0, backgroundAlpha != 255 {
                clippedForegroundPixels += 1
            }

            // Both buffers use premultiplied RGBA. A pure-white background
            // contributes its alpha equally to R/G/B.
            let backgroundContribution =
                (backgroundAlpha * (255 - sourceAlpha) + 127) / 255
            output[offset] = UInt8(
                clamping: Int(foreground[offset]) + backgroundContribution
            )
            output[offset + 1] = UInt8(
                clamping: Int(foreground[offset + 1]) + backgroundContribution
            )
            output[offset + 2] = UInt8(
                clamping: Int(foreground[offset + 2]) + backgroundContribution
            )
            output[offset + 3] = UInt8(
                clamping: sourceAlpha + backgroundContribution
            )
        }
    }

    guard clippedForegroundPixels == 0 else {
        fail("approved squircle would clip \(clippedForegroundPixels) canonical pixels")
    }
    return output
}

private func writePNG(premultipliedRGBA: [UInt8], to url: URL) {
    guard
        let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
        let provider = CGDataProvider(data: Data(premultipliedRGBA) as CFData),
        let image = CGImage(
            width: canvasSize,
            height: canvasSize,
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            bytesPerRow: canvasSize * 4,
            space: colorSpace,
            bitmapInfo: CGBitmapInfo(
                rawValue: CGBitmapInfo.byteOrder32Big.rawValue
                    | CGImageAlphaInfo.premultipliedLast.rawValue
            ),
            provider: provider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent
        ),
        let destination = CGImageDestinationCreateWithURL(
            url as CFURL,
            UTType.png.identifier as CFString,
            1,
            nil
        )
    else {
        fail("cannot create PNG destination \(url.path)")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        fail("cannot finalize \(url.path)")
    }
}

private func centerOnTransparentCanvas(_ composite: [UInt8]) -> [UInt8] {
    let expectedBytes = dockCompositeSize * dockCompositeSize * 4
    guard composite.count == expectedBytes else {
        fail(
            "scaled composite must contain \(expectedBytes) RGBA bytes, got \(composite.count)"
        )
    }

    var output = [UInt8](repeating: 0, count: canvasSize * canvasSize * 4)
    let sourceBytesPerRow = dockCompositeSize * 4
    for y in 0..<dockCompositeSize {
        let sourceStart = y * sourceBytesPerRow
        let destinationStart =
            ((y + dockSafeArea) * canvasSize + dockSafeArea) * 4
        output.replaceSubrange(
            destinationStart..<(destinationStart + sourceBytesPerRow),
            with: composite[sourceStart..<(sourceStart + sourceBytesPerRow)]
        )
    }
    return output
}

private func buildIconset(master: URL, in directory: URL) -> URL {
    let fileManager = FileManager.default
    let iconset = directory.appendingPathComponent("HexClaw.iconset")
    do {
        try fileManager.createDirectory(at: iconset, withIntermediateDirectories: true)
    } catch {
        fail("cannot create iconset: \(error)")
    }

    let representations: [(String, Int)] = [
        ("icon_16x16.png", 16),
        ("icon_16x16@2x.png", 32),
        ("icon_32x32.png", 32),
        ("icon_32x32@2x.png", 64),
        ("icon_128x128.png", 128),
        ("icon_128x128@2x.png", 256),
        ("icon_256x256.png", 256),
        ("icon_256x256@2x.png", 512),
        ("icon_512x512.png", 512),
        ("icon_512x512@2x.png", 1024),
    ]
    var generatedBySize: [Int: URL] = [:]
    for (name, size) in representations {
        let destination = iconset.appendingPathComponent(name)
        if size == canvasSize {
            do {
                try fileManager.copyItem(at: master, to: destination)
            } catch {
                fail("cannot copy 1024 master into iconset: \(error)")
            }
            continue
        }
        if let existing = generatedBySize[size] {
            do {
                try fileManager.copyItem(at: existing, to: destination)
            } catch {
                fail("cannot copy \(size)x\(size) representation: \(error)")
            }
            continue
        }
        run(
            "/usr/bin/sips",
            [
                "-z", "\(size)", "\(size)",
                master.path,
                "--out", destination.path,
            ]
        )
        generatedBySize[size] = destination
    }
    return iconset
}

guard CommandLine.arguments.count == 4 else {
    fail(
        "usage: generate-macos-app-icon.swift <canonical-logo.png> <master.png> <icon.icns>"
    )
}

let canonicalURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputMasterURL = URL(fileURLWithPath: CommandLine.arguments[2])
let outputICNSURL = URL(fileURLWithPath: CommandLine.arguments[3])
verifyCanonicalIdentity(at: canonicalURL)

let fileManager = FileManager.default
let sandbox = fileManager.temporaryDirectory.appendingPathComponent(
    "hexclaw-macos-app-icon-\(UUID().uuidString)",
    isDirectory: true
)
do {
    try fileManager.createDirectory(at: sandbox, withIntermediateDirectories: true)
} catch {
    fail("cannot create isolated generator directory: \(error)")
}
defer { try? fileManager.removeItem(at: sandbox) }

let foregroundURL = sandbox.appendingPathComponent("canonical-1024.png")
run(
    "/usr/bin/sips",
    [
        "-z", "\(canvasSize)", "\(canvasSize)",
        canonicalURL.path,
        "--out", foregroundURL.path,
    ]
)
let foreground = loadPremultipliedRGBA(
    from: foregroundURL,
    expectedWidth: canvasSize,
    expectedHeight: canvasSize
)
guard sha256(Data(foreground)) == approvedForegroundPixelSHA256 else {
    fail("512→1024 canonical foreground pixel identity drifted")
}

let fullCompositeURL = sandbox.appendingPathComponent("full-composite-1024.png")
writePNG(
    premultipliedRGBA: composeWhiteSquircle(behind: foreground),
    to: fullCompositeURL
)

let scaledCompositeURL = sandbox.appendingPathComponent("scaled-composite-824.png")
run(
    "/usr/bin/sips",
    [
        "-z", "\(dockCompositeSize)", "\(dockCompositeSize)",
        fullCompositeURL.path,
        "--out", scaledCompositeURL.path,
    ]
)
let scaledComposite = loadPremultipliedRGBA(
    from: scaledCompositeURL,
    expectedWidth: dockCompositeSize,
    expectedHeight: dockCompositeSize
)

let generatedMaster = sandbox.appendingPathComponent("master.png")
writePNG(
    premultipliedRGBA: centerOnTransparentCanvas(scaledComposite),
    to: generatedMaster
)
let iconset = buildIconset(master: generatedMaster, in: sandbox)
let generatedICNS = sandbox.appendingPathComponent("icon.icns")
run(
    "/usr/bin/iconutil",
    ["-c", "icns", iconset.path, "-o", generatedICNS.path]
)

do {
    try fileManager.createDirectory(
        at: outputMasterURL.deletingLastPathComponent(),
        withIntermediateDirectories: true
    )
    try fileManager.createDirectory(
        at: outputICNSURL.deletingLastPathComponent(),
        withIntermediateDirectories: true
    )
    try Data(contentsOf: generatedMaster).write(to: outputMasterURL, options: .atomic)
    try Data(contentsOf: generatedICNS).write(to: outputICNSURL, options: .atomic)
} catch {
    fail("cannot atomically publish generated assets: \(error)")
}
