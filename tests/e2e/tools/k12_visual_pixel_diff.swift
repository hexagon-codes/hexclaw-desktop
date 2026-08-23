#!/usr/bin/env swift

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("\(message)\n".utf8))
  exit(1)
}

guard CommandLine.arguments.count == 5 else {
  fail("usage: k12_visual_pixel_diff.swift <reference.png> <implementation.png> <diff.png> <threshold>")
}

let referenceURL = URL(fileURLWithPath: CommandLine.arguments[1])
let implementationURL = URL(fileURLWithPath: CommandLine.arguments[2])
let diffURL = URL(fileURLWithPath: CommandLine.arguments[3])
guard let threshold = Int(CommandLine.arguments[4]), (0 ... 255).contains(threshold) else {
  fail("threshold must be an integer from 0 through 255")
}

func loadRGBA(_ url: URL) -> (width: Int, height: Int, pixels: [UInt8]) {
  guard
    let source = CGImageSourceCreateWithURL(url as CFURL, nil),
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
  else {
    fail("cannot decode PNG: \(url.path)")
  }
  let width = image.width
  let height = image.height
  var pixels = [UInt8](repeating: 0, count: width * height * 4)
  let colorSpace = CGColorSpaceCreateDeviceRGB()
  let bitmapInfo = CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue
  let rendered = pixels.withUnsafeMutableBytes { bytes -> Bool in
    guard
      let context = CGContext(
        data: bytes.baseAddress,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * 4,
        space: colorSpace,
        bitmapInfo: bitmapInfo
      )
    else { return false }
    context.translateBy(x: 0, y: CGFloat(height))
    context.scaleBy(x: 1, y: -1)
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return true
  }
  if !rendered { fail("cannot render PNG as RGBA: \(url.path)") }
  return (width, height, pixels)
}

func saveRGBA(_ pixels: [UInt8], width: Int, height: Int, to url: URL) {
  try? FileManager.default.createDirectory(
    at: url.deletingLastPathComponent(),
    withIntermediateDirectories: true
  )
  let data = Data(pixels)
  guard
    let provider = CGDataProvider(data: data as CFData),
    let image = CGImage(
      width: width,
      height: height,
      bitsPerComponent: 8,
      bitsPerPixel: 32,
      bytesPerRow: width * 4,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGBitmapInfo(
        rawValue: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue
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
    fail("cannot create diff PNG: \(url.path)")
  }
  CGImageDestinationAddImage(destination, image, nil)
  if !CGImageDestinationFinalize(destination) {
    fail("cannot write diff PNG: \(url.path)")
  }
}

let reference = loadRGBA(referenceURL)
let implementation = loadRGBA(implementationURL)
guard reference.width == implementation.width, reference.height == implementation.height else {
  fail(
    "screenshot size mismatch: reference=(\(reference.width), \(reference.height)), "
      + "implementation=(\(implementation.width), \(implementation.height))"
  )
}

var output = [UInt8](repeating: 0, count: reference.pixels.count)
var changedPixels = 0
var minimumX = reference.width
var minimumY = reference.height
var maximumX = -1
var maximumY = -1

for y in 0 ..< reference.height {
  for x in 0 ..< reference.width {
    let offset = (y * reference.width + x) * 4
    let redDelta = abs(Int(reference.pixels[offset]) - Int(implementation.pixels[offset]))
    let greenDelta = abs(Int(reference.pixels[offset + 1]) - Int(implementation.pixels[offset + 1]))
    let blueDelta = abs(Int(reference.pixels[offset + 2]) - Int(implementation.pixels[offset + 2]))
    let changed = max(redDelta, greenDelta, blueDelta) > threshold
    if changed {
      changedPixels += 1
      minimumX = min(minimumX, x)
      minimumY = min(minimumY, y)
      maximumX = max(maximumX, x)
      maximumY = max(maximumY, y)
      output[offset] = 255
      output[offset + 1] = 35
      output[offset + 2] = 35
    } else {
      let gray = (
        299 * Int(reference.pixels[offset])
          + 587 * Int(reference.pixels[offset + 1])
          + 114 * Int(reference.pixels[offset + 2])
          + 500
      ) / 1000
      let dimmed = UInt8(max(0, min(255, Int(Double(gray) * 0.45))))
      output[offset] = dimmed
      output[offset + 1] = dimmed
      output[offset + 2] = dimmed
    }
    output[offset + 3] = 255
  }
}

saveRGBA(output, width: reference.width, height: reference.height, to: diffURL)
let totalPixels = reference.width * reference.height
let report: [String: Any] = [
  "width": reference.width,
  "height": reference.height,
  "threshold": threshold,
  "changed_pixels": changedPixels,
  "total_pixels": totalPixels,
  "changed_pixel_ratio": totalPixels == 0 ? 0 : Double(changedPixels) / Double(totalPixels),
  "changed_bbox": changedPixels == 0
    ? NSNull()
    : [minimumX, minimumY, maximumX + 1, maximumY + 1],
]
guard let encoded = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]) else {
  fail("cannot encode diff report")
}
FileHandle.standardOutput.write(encoded)
FileHandle.standardOutput.write(Data("\n".utf8))
