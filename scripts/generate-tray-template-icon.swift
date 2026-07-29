#!/usr/bin/env swift

import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

private let outputWidth = 88
private let outputHeight = 88
private let approvedCanonicalSHA256 =
    "31535cf7230cd31795c5a4ec6eb5ae64f617fb65e3c7f1f0a0b75432b0990c53"

private func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("tray icon generation failed: \(message)\n".utf8))
    exit(1)
}

private func verifyCanonicalIdentity(at url: URL) {
    guard let data = try? Data(contentsOf: url) else {
        fail("cannot read \(url.path)")
    }
    let actual = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    guard actual == approvedCanonicalSHA256 else {
        fail(
            "canonical logo SHA-256 must remain \(approvedCanonicalSHA256), got \(actual)"
        )
    }
}

private func loadRGBA(from url: URL) -> (width: Int, height: Int, pixels: [UInt8]) {
    guard
        let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        fail("cannot decode \(url.path)")
    }

    let width = image.width
    let height = image.height
    guard width == 512, height == 512 else {
        fail("canonical logo must remain 512x512, got \(width)x\(height)")
    }

    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bitmapInfo = CGBitmapInfo.byteOrder32Big.rawValue
        | CGImageAlphaInfo.premultipliedLast.rawValue
    guard
        let context = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: colorSpace,
            bitmapInfo: bitmapInfo
        )
    else {
        fail("cannot allocate RGBA decode context")
    }

    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return (width, height, pixels)
}

private func fillEnclosedHoles(
    foreground: [Bool],
    width: Int,
    height: Int
) -> [Bool] {
    var exterior = [Bool](repeating: false, count: foreground.count)
    var queue = [Int]()
    queue.reserveCapacity(foreground.count)

    func enqueue(_ x: Int, _ y: Int) {
        let index = y * width + x
        if !foreground[index], !exterior[index] {
            exterior[index] = true
            queue.append(index)
        }
    }

    for x in 0..<width {
        enqueue(x, 0)
        enqueue(x, height - 1)
    }
    for y in 0..<height {
        enqueue(0, y)
        enqueue(width - 1, y)
    }

    var cursor = 0
    while cursor < queue.count {
        let index = queue[cursor]
        cursor += 1
        let x = index % width
        let y = index / width
        if x > 0 { enqueue(x - 1, y) }
        if x + 1 < width { enqueue(x + 1, y) }
        if y > 0 { enqueue(x, y - 1) }
        if y + 1 < height { enqueue(x, y + 1) }
    }

    return foreground.indices.map { foreground[$0] || !exterior[$0] }
}

private func deriveSourceMask(
    width: Int,
    height: Int,
    pixels: [UInt8]
) -> [UInt8] {
    var crabSeed = [Bool](repeating: false, count: width * height)
    for index in 0..<(width * height) {
        let offset = index * 4
        let red = Int(pixels[offset])
        let blue = Int(pixels[offset + 2])
        let alpha = pixels[offset + 3]
        crabSeed[index] = alpha >= 48 && red - blue >= 40 && red >= 100
    }

    // Golden pixels establish the canonical crab foreground. Filling only
    // holes disconnected from the canvas exterior includes its dark eyes,
    // highlights and mouth without swallowing the blue gaps between legs.
    let crab = fillEnclosedHoles(foreground: crabSeed, width: width, height: height)
    return (0..<(width * height)).map { index in
        crab[index] ? 0 : pixels[index * 4 + 3]
    }
}

private func areaDownsample(
    source: [UInt8],
    sourceWidth: Int,
    sourceHeight: Int
) -> [UInt8] {
    var output = [UInt8](repeating: 0, count: outputWidth * outputHeight)

    for outputY in 0..<outputHeight {
        let sourceY0 = Double(outputY * sourceHeight) / Double(outputHeight)
        let sourceY1 = Double((outputY + 1) * sourceHeight) / Double(outputHeight)
        let firstY = Int(floor(sourceY0))
        let lastY = Int(ceil(sourceY1))

        for outputX in 0..<outputWidth {
            let sourceX0 = Double(outputX * sourceWidth) / Double(outputWidth)
            let sourceX1 = Double((outputX + 1) * sourceWidth) / Double(outputWidth)
            let firstX = Int(floor(sourceX0))
            let lastX = Int(ceil(sourceX1))
            var weightedAlpha = 0.0
            var totalWeight = 0.0

            for sourceY in firstY..<lastY where sourceY < sourceHeight {
                let yWeight = max(
                    0,
                    min(sourceY1, Double(sourceY + 1)) - max(sourceY0, Double(sourceY))
                )
                for sourceX in firstX..<lastX where sourceX < sourceWidth {
                    let xWeight = max(
                        0,
                        min(sourceX1, Double(sourceX + 1)) - max(sourceX0, Double(sourceX))
                    )
                    let weight = xWeight * yWeight
                    weightedAlpha += Double(source[sourceY * sourceWidth + sourceX]) * weight
                    totalWeight += weight
                }
            }

            output[outputY * outputWidth + outputX] =
                UInt8(clamping: Int((weightedAlpha / totalWeight).rounded()))
        }
    }

    return output
}

private func writePNG(alpha: [UInt8], to url: URL) {
    var rgba = [UInt8](repeating: 0, count: outputWidth * outputHeight * 4)
    for index in alpha.indices {
        rgba[index * 4 + 3] = alpha[index]
    }

    guard
        let provider = CGDataProvider(data: Data(rgba) as CFData),
        let image = CGImage(
            width: outputWidth,
            height: outputHeight,
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            bytesPerRow: outputWidth * 4,
            space: CGColorSpaceCreateDeviceRGB(),
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

guard CommandLine.arguments.count == 3 else {
    fail("usage: generate-tray-template-icon.swift <canonical-logo.png> <tray-icon.png>")
}

let sourceURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])
verifyCanonicalIdentity(at: sourceURL)
let canonical = loadRGBA(from: sourceURL)
let sourceMask = deriveSourceMask(
    width: canonical.width,
    height: canonical.height,
    pixels: canonical.pixels
)
let outputMask = areaDownsample(
    source: sourceMask,
    sourceWidth: canonical.width,
    sourceHeight: canonical.height
)
writePNG(alpha: outputMask, to: outputURL)
