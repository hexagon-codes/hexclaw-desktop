import ApplicationServices
import AppKit
import CoreGraphics
import Foundation

enum ProbeError: Error, CustomStringConvertible {
    case invalidArguments(String)
    case operationFailed(String)

    var description: String {
        switch self {
        case .invalidArguments(let message), .operationFailed(let message):
            return message
        }
    }
}

func emitJSON(_ value: Any) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    guard let text = String(data: data, encoding: .utf8) else {
        throw ProbeError.operationFailed("failed to encode JSON")
    }
    print(text)
}

func numberArgument(_ raw: String, name: String) throws -> Double {
    guard let value = Double(raw) else {
        throw ProbeError.invalidArguments("\(name) must be numeric")
    }
    return value
}

func pidArgument(_ raw: String) throws -> pid_t {
    guard let value = Int32(raw), value > 0 else {
        throw ProbeError.invalidArguments("pid must be a positive integer")
    }
    return value
}

func copyAttribute(_ element: AXUIElement, _ attribute: CFString) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else {
        return nil
    }
    return value
}

func stringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String? {
    copyAttribute(element, attribute) as? String
}

func boolAttribute(_ element: AXUIElement, _ attribute: CFString) -> Bool? {
    guard let value = copyAttribute(element, attribute) else { return nil }
    if CFGetTypeID(value) == CFBooleanGetTypeID() {
        return CFBooleanGetValue((value as! CFBoolean))
    }
    return nil
}

func pointAttribute(_ element: AXUIElement, _ attribute: CFString) -> CGPoint? {
    guard let value = copyAttribute(element, attribute), CFGetTypeID(value) == AXValueGetTypeID() else {
        return nil
    }
    var point = CGPoint.zero
    guard AXValueGetValue(value as! AXValue, .cgPoint, &point) else { return nil }
    return point
}

func sizeAttribute(_ element: AXUIElement, _ attribute: CFString) -> CGSize? {
    guard let value = copyAttribute(element, attribute), CFGetTypeID(value) == AXValueGetTypeID() else {
        return nil
    }
    var size = CGSize.zero
    guard AXValueGetValue(value as! AXValue, .cgSize, &size) else { return nil }
    return size
}

func childElements(_ element: AXUIElement) -> [AXUIElement] {
    (copyAttribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement]) ?? []
}

func describeElement(_ element: AXUIElement, depth: Int) -> [String: Any] {
    var row: [String: Any] = ["depth": depth]
    if let role = stringAttribute(element, kAXRoleAttribute as CFString) { row["role"] = role }
    if let subrole = stringAttribute(element, kAXSubroleAttribute as CFString) { row["subrole"] = subrole }
    if let title = stringAttribute(element, kAXTitleAttribute as CFString), !title.isEmpty {
        row["title"] = title
    }
    if let description = stringAttribute(element, kAXDescriptionAttribute as CFString), !description.isEmpty {
        row["description"] = description
    }
    if let enabled = boolAttribute(element, kAXEnabledAttribute as CFString) { row["enabled"] = enabled }
    if let visible = boolAttribute(element, "AXVisible" as CFString) { row["visible"] = visible }
    if let focused = boolAttribute(element, kAXFocusedAttribute as CFString) { row["focused"] = focused }
    if let position = pointAttribute(element, kAXPositionAttribute as CFString),
       let size = sizeAttribute(element, kAXSizeAttribute as CFString) {
        row["bounds"] = [
            "x": position.x,
            "y": position.y,
            "width": size.width,
            "height": size.height,
        ]
        if row["visible"] == nil {
            row["visible"] = size.width > 0 && size.height > 0
        }
    }
    return row
}

func walk(_ root: AXUIElement, maximumDepth: Int = 12, maximumElements: Int = 4000) -> [(AXUIElement, [String: Any])] {
    var result: [(AXUIElement, [String: Any])] = []
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var cursor = 0
    while cursor < queue.count && result.count < maximumElements {
        let (element, depth) = queue[cursor]
        cursor += 1
        result.append((element, describeElement(element, depth: depth)))
        if depth < maximumDepth {
            for child in childElements(element) {
                queue.append((child, depth + 1))
            }
        }
    }
    return result
}

func windowRows(for pid: pid_t, onScreenOnly: Bool) -> [[String: Any]] {
    var options: CGWindowListOption = [.excludeDesktopElements]
    if onScreenOnly { options.insert(.optionOnScreenOnly) }
    let rows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
    return rows.compactMap { row in
        let ownerPID = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? -1
        guard ownerPID == pid else { return nil }
        let bounds = row[kCGWindowBounds as String] as? [String: Any] ?? [:]
        let x = (bounds["X"] as? NSNumber)?.doubleValue ?? 0
        let y = (bounds["Y"] as? NSNumber)?.doubleValue ?? 0
        let width = (bounds["Width"] as? NSNumber)?.doubleValue ?? 0
        let height = (bounds["Height"] as? NSNumber)?.doubleValue ?? 0
        return [
            "id": (row[kCGWindowNumber as String] as? NSNumber)?.intValue ?? -1,
            "layer": (row[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1,
            "alpha": (row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0,
            "name": row[kCGWindowName as String] as? String ?? "",
            "owner": row[kCGWindowOwnerName as String] as? String ?? "",
            "bounds": [
                "x": x,
                "y": y,
                "width": width,
                "height": height,
            ],
        ]
    }
}

func statusItems(for targetPID: pid_t) -> [[String: Any]] {
    let system = AXUIElementCreateSystemWide()
    var result: [[String: Any]] = []
    var seen = Set<String>()
    for screen in NSScreen.screens {
        let frame = screen.frame
        let minX = Int(frame.minX)
        let maxX = Int(frame.maxX)
        let minY = Int(frame.minY)
        let scanY = [minY + 4, minY + 10, minY + 16, minY + 22]
        for y in scanY {
            var x = minX + 2
            while x < maxX - 2 {
                var element: AXUIElement?
                if AXUIElementCopyElementAtPosition(system, Float(x), Float(y), &element) == .success,
                   let element {
                    var ownerPID: pid_t = 0
                    if AXUIElementGetPid(element, &ownerPID) == .success, ownerPID == targetPID {
                        let row = describeElement(element, depth: 0)
                        if let bounds = row["bounds"] as? [String: Any],
                           let bx = bounds["x"] as? Double,
                           let by = bounds["y"] as? Double,
                           let width = bounds["width"] as? Double,
                           let height = bounds["height"] as? Double {
                            let key = "\(bx)|\(by)|\(width)|\(height)"
                            if !seen.contains(key) {
                                seen.insert(key)
                                result.append(row)
                            }
                        }
                    }
                }
                x += 2
            }
        }
    }
    return result
}

func elementMatches(_ row: [String: Any], selector: String) -> Bool {
    for key in ["title", "description"] {
        if let value = row[key] as? String, value == selector { return true }
    }
    return false
}

func performPress(pid: pid_t, selector: String, visibleOnly: Bool = false) throws -> [String: Any] {
    let root = AXUIElementCreateApplication(pid)
    for (element, row) in walk(root)
    where elementMatches(row, selector: selector) && (!visibleOnly || row["visible"] as? Bool == true) {
        let error = AXUIElementPerformAction(element, kAXPressAction as CFString)
        guard error == .success else {
            throw ProbeError.operationFailed("AXPress failed with code \(error.rawValue)")
        }
        return row
    }
    throw ProbeError.operationFailed("no AX element exactly matched selector")
}

func performSubrolePress(pid: pid_t, subrole: String) throws -> [String: Any] {
    let root = AXUIElementCreateApplication(pid)
    for (element, row) in walk(root) where row["subrole"] as? String == subrole {
        let error = AXUIElementPerformAction(element, kAXPressAction as CFString)
        guard error == .success else {
            throw ProbeError.operationFailed("AXPress failed with code \(error.rawValue)")
        }
        return row
    }
    throw ProbeError.operationFailed("no AX element matched subrole")
}

func performWindowSubrolePress(pid: pid_t, windowTitle: String, subrole: String) throws -> [String: Any] {
    let root = AXUIElementCreateApplication(pid)
    let windows = (copyAttribute(root, kAXWindowsAttribute as CFString) as? [AXUIElement]) ?? []
    guard let window = windows.first(where: {
        stringAttribute($0, kAXTitleAttribute as CFString) == windowTitle
    }) else {
        throw ProbeError.operationFailed("no AX window exactly matched title")
    }
    for (element, row) in walk(window) where row["subrole"] as? String == subrole {
        let error = AXUIElementPerformAction(element, kAXPressAction as CFString)
        guard error == .success else {
            throw ProbeError.operationFailed("AXPress failed with code \(error.rawValue)")
        }
        return row
    }
    throw ProbeError.operationFailed("no AX element matched subrole inside window")
}

func activate(pid: pid_t) throws {
    guard let application = NSRunningApplication(processIdentifier: pid) else {
        throw ProbeError.operationFailed("candidate process is not running")
    }
    guard application.activate(options: [.activateAllWindows]) else {
        throw ProbeError.operationFailed("candidate activation failed")
    }
}

func click(x: Double, y: Double, right: Bool) throws {
    let point = CGPoint(x: x, y: y)
    guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: right ? .right : .left),
          let down = CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseDown : .leftMouseDown, mouseCursorPosition: point, mouseButton: right ? .right : .left),
          let up = CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseUp : .leftMouseUp, mouseCursorPosition: point, mouseButton: right ? .right : .left) else {
        throw ProbeError.operationFailed("failed to construct mouse events")
    }
    move.post(tap: .cghidEventTap)
    usleep(50_000)
    down.post(tap: .cghidEventTap)
    usleep(50_000)
    up.post(tap: .cghidEventTap)
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard let command = arguments.first else {
        throw ProbeError.invalidArguments("missing command")
    }
    switch command {
    case "preflight":
        try emitJSON([
            "accessibility": AXIsProcessTrusted(),
            "screenCapture": CGPreflightScreenCaptureAccess(),
        ])
    case "windows":
        guard arguments.count == 2 else { throw ProbeError.invalidArguments("windows requires pid") }
        try emitJSON(windowRows(for: try pidArgument(arguments[1]), onScreenOnly: true))
    case "all-windows":
        guard arguments.count == 2 else { throw ProbeError.invalidArguments("all-windows requires pid") }
        try emitJSON(windowRows(for: try pidArgument(arguments[1]), onScreenOnly: false))
    case "status-items":
        guard arguments.count == 2 else { throw ProbeError.invalidArguments("status-items requires pid") }
        try emitJSON(statusItems(for: try pidArgument(arguments[1])))
    case "ax":
        guard arguments.count == 2 else { throw ProbeError.invalidArguments("ax requires pid") }
        let rows = walk(AXUIElementCreateApplication(try pidArgument(arguments[1]))).map { $0.1 }
        try emitJSON(rows)
    case "activate":
        guard arguments.count == 2 else { throw ProbeError.invalidArguments("activate requires pid") }
        try activate(pid: try pidArgument(arguments[1]))
        try emitJSON(["ok": true])
    case "press":
        guard arguments.count == 3 else { throw ProbeError.invalidArguments("press requires pid and exact selector") }
        try emitJSON(performPress(pid: try pidArgument(arguments[1]), selector: arguments[2]))
    case "press-visible":
        guard arguments.count == 3 else { throw ProbeError.invalidArguments("press-visible requires pid and exact selector") }
        try emitJSON(performPress(pid: try pidArgument(arguments[1]), selector: arguments[2], visibleOnly: true))
    case "press-subrole":
        guard arguments.count == 3 else { throw ProbeError.invalidArguments("press-subrole requires pid and subrole") }
        try emitJSON(performSubrolePress(pid: try pidArgument(arguments[1]), subrole: arguments[2]))
    case "press-window-subrole":
        guard arguments.count == 4 else { throw ProbeError.invalidArguments("press-window-subrole requires pid, exact window title, and subrole") }
        try emitJSON(performWindowSubrolePress(pid: try pidArgument(arguments[1]), windowTitle: arguments[2], subrole: arguments[3]))
    case "click":
        guard arguments.count == 4 else { throw ProbeError.invalidArguments("click requires x, y, and left|right") }
        let button = arguments[3]
        guard button == "left" || button == "right" else {
            throw ProbeError.invalidArguments("button must be left or right")
        }
        try click(
            x: try numberArgument(arguments[1], name: "x"),
            y: try numberArgument(arguments[2], name: "y"),
            right: button == "right"
        )
        try emitJSON(["ok": true, "button": button])
    default:
        throw ProbeError.invalidArguments("unknown command")
    }
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(2)
}
