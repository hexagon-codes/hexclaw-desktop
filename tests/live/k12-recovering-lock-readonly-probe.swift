import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum ProbeError: Error, CustomStringConvertible {
    case invalid(String)

    var description: String {
        switch self {
        case .invalid(let message): return message
        }
    }
}

func emitJSON(_ value: Any) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    guard let text = String(data: data, encoding: .utf8) else {
        throw ProbeError.invalid("JSON_ENCODE_FAILED")
    }
    print(text)
}

func positivePID(_ raw: String) throws -> pid_t {
    guard let value = Int32(raw), value > 0 else {
        throw ProbeError.invalid("PID_INVALID")
    }
    return value
}

func attribute(_ element: AXUIElement, _ name: CFString) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
    return value
}

func stringAttribute(_ element: AXUIElement, _ name: CFString) -> String? {
    attribute(element, name) as? String
}

func boolAttribute(_ element: AXUIElement, _ name: CFString) -> Bool? {
    guard let value = attribute(element, name), CFGetTypeID(value) == CFBooleanGetTypeID() else {
        return nil
    }
    return CFBooleanGetValue((value as! CFBoolean))
}

func pointAttribute(_ element: AXUIElement, _ name: CFString) -> CGPoint? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXValueGetTypeID() else {
        return nil
    }
    var point = CGPoint.zero
    guard AXValueGetValue(value as! AXValue, .cgPoint, &point) else { return nil }
    return point
}

func sizeAttribute(_ element: AXUIElement, _ name: CFString) -> CGSize? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXValueGetTypeID() else {
        return nil
    }
    var size = CGSize.zero
    guard AXValueGetValue(value as! AXValue, .cgSize, &size) else { return nil }
    return size
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    var count: CFIndex = 0
    guard AXUIElementGetAttributeValueCount(
        element, kAXChildrenAttribute as CFString, &count
    ) == .success, count > 0 else {
        return []
    }
    var values: CFArray?
    guard AXUIElementCopyAttributeValues(
        element, kAXChildrenAttribute as CFString, 0, count, &values
    ) == .success else {
        return []
    }
    return (values as? [AXUIElement]) ?? []
}

func describe(_ element: AXUIElement, depth: Int) -> [String: Any] {
    var row: [String: Any] = ["depth": depth]
    if let value = stringAttribute(element, kAXRoleAttribute as CFString) { row["role"] = value }
    if let value = stringAttribute(element, kAXTitleAttribute as CFString), !value.isEmpty {
        row["title"] = value
    }
    if let value = stringAttribute(element, kAXDescriptionAttribute as CFString), !value.isEmpty {
        row["description"] = value
    }
    if let value = boolAttribute(element, kAXEnabledAttribute as CFString) { row["enabled"] = value }
    if let value = boolAttribute(element, "AXVisible" as CFString) { row["visible"] = value }
    if let point = pointAttribute(element, kAXPositionAttribute as CFString),
       let size = sizeAttribute(element, kAXSizeAttribute as CFString) {
        row["bounds"] = [
            "x": point.x, "y": point.y, "width": size.width, "height": size.height,
        ]
        if row["visible"] == nil { row["visible"] = size.width > 0 && size.height > 0 }
    }
    return row
}

func walk(_ root: AXUIElement) -> [[String: Any]] {
    var rows: [[String: Any]] = []
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var seen = Set<String>()
    var cursor = 0
    while cursor < queue.count && rows.count < 5_000 {
        let (element, depth) = queue[cursor]
        cursor += 1
        if depth > 0, stringAttribute(element, kAXRoleAttribute as CFString) == "AXApplication" {
            continue
        }
        let identity = String(describing: element)
        if seen.contains(identity) { continue }
        seen.insert(identity)
        rows.append(describe(element, depth: depth))
        if depth < 16 {
            for child in children(element) { queue.append((child, depth + 1)) }
        }
    }
    return rows
}

func windowID(for pid: pid_t) throws -> Int {
    let rows = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
    ) as? [[String: Any]] ?? []
    for row in rows {
        let owner = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? -1
        let layer = (row[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1
        if owner == pid, layer == 0,
           let identifier = (row[kCGWindowNumber as String] as? NSNumber)?.intValue {
            return identifier
        }
    }
    throw ProbeError.invalid("WINDOW_NOT_FOUND")
}

func loadImage(_ path: String) throws -> CGImage {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let source = CGImageSourceCreateWithURL(url, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw ProbeError.invalid("IMAGE_READ_FAILED")
    }
    return image
}

func rgba(_ image: CGImage) throws -> [UInt8] {
    var pixels = [UInt8](repeating: 0, count: image.width * image.height * 4)
    guard let context = CGContext(
        data: &pixels,
        width: image.width,
        height: image.height,
        bitsPerComponent: 8,
        bytesPerRow: image.width * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        throw ProbeError.invalid("IMAGE_CONTEXT_FAILED")
    }
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    return pixels
}

func writeDifference(_ referencePath: String, _ implementationPath: String, _ outputPath: String) throws -> [String: Any] {
    let reference = try loadImage(referencePath)
    let implementation = try loadImage(implementationPath)
    guard reference.width == implementation.width, reference.height == implementation.height else {
        throw ProbeError.invalid("IMAGE_DIMENSIONS_DIFFER")
    }
    let left = try rgba(reference)
    let right = try rgba(implementation)
    var output = [UInt8](repeating: 255, count: left.count)
    var different = 0
    for pixel in 0..<(reference.width * reference.height) {
        let offset = pixel * 4
        let delta = max(
            abs(Int(left[offset]) - Int(right[offset])),
            abs(Int(left[offset + 1]) - Int(right[offset + 1])),
            abs(Int(left[offset + 2]) - Int(right[offset + 2]))
        )
        if delta > 0 { different += 1 }
        output[offset] = 255
        output[offset + 1] = UInt8(max(0, 255 - delta))
        output[offset + 2] = UInt8(max(0, 255 - delta))
        output[offset + 3] = 255
    }
    let data = Data(output)
    guard let provider = CGDataProvider(data: data as CFData),
          let image = CGImage(
              width: reference.width,
              height: reference.height,
              bitsPerComponent: 8,
              bitsPerPixel: 32,
              bytesPerRow: reference.width * 4,
              space: CGColorSpaceCreateDeviceRGB(),
              bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
              provider: provider,
              decode: nil,
              shouldInterpolate: false,
              intent: .defaultIntent
          ) else {
        throw ProbeError.invalid("DIFF_IMAGE_CREATE_FAILED")
    }
    let outputURL = URL(fileURLWithPath: outputPath) as CFURL
    guard let destination = CGImageDestinationCreateWithURL(
        outputURL, UTType.png.identifier as CFString, 1, nil
    ) else {
        throw ProbeError.invalid("DIFF_DESTINATION_FAILED")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw ProbeError.invalid("DIFF_WRITE_FAILED")
    }
    let total = reference.width * reference.height
    return [
        "width": reference.width,
        "height": reference.height,
        "different_pixels": different,
        "pixel_difference_rate": total == 0 ? 0 : Double(different) / Double(total),
    ]
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard let command = arguments.first else { throw ProbeError.invalid("COMMAND_REQUIRED") }
    switch command {
    case "preflight":
        try emitJSON([
            "accessibility": AXIsProcessTrusted(),
            "screen_capture": CGPreflightScreenCaptureAccess(),
        ])
    case "ax":
        guard arguments.count == 2 else { throw ProbeError.invalid("AX_ARGUMENTS_INVALID") }
        try emitJSON(walk(AXUIElementCreateApplication(try positivePID(arguments[1]))))
    case "window":
        guard arguments.count == 2 else { throw ProbeError.invalid("WINDOW_ARGUMENTS_INVALID") }
        try emitJSON(["window_id": try windowID(for: positivePID(arguments[1]))])
    case "diff":
        guard arguments.count == 4 else { throw ProbeError.invalid("DIFF_ARGUMENTS_INVALID") }
        try emitJSON(try writeDifference(arguments[1], arguments[2], arguments[3]))
    default:
        throw ProbeError.invalid("COMMAND_UNKNOWN")
    }
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(2)
}
