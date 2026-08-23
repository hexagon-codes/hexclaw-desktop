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
    guard let value = copyAttribute(element, attribute), CFGetTypeID(value) == CFBooleanGetTypeID() else {
        return nil
    }
    return CFBooleanGetValue((value as! CFBoolean))
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

func describe(_ element: AXUIElement, pid: pid_t?) -> [String: Any] {
    var row: [String: Any] = [:]
    var ownerPID: pid_t = 0
    if AXUIElementGetPid(element, &ownerPID) == .success {
        row["pid"] = ownerPID
    } else if let pid {
        row["pid"] = pid
    }
    if let role = stringAttribute(element, kAXRoleAttribute as CFString) { row["role"] = role }
    if let subrole = stringAttribute(element, kAXSubroleAttribute as CFString) { row["subrole"] = subrole }
    if let title = stringAttribute(element, kAXTitleAttribute as CFString), !title.isEmpty { row["title"] = title }
    if let description = stringAttribute(element, kAXDescriptionAttribute as CFString), !description.isEmpty { row["description"] = description }
    if let roleDescription = stringAttribute(element, kAXRoleDescriptionAttribute as CFString), !roleDescription.isEmpty { row["roleDescription"] = roleDescription }
    if let enabled = boolAttribute(element, kAXEnabledAttribute as CFString) { row["enabled"] = enabled }
    if let visible = boolAttribute(element, "AXVisible" as CFString) { row["visible"] = visible }
    if let point = pointAttribute(element, kAXPositionAttribute as CFString),
       let size = sizeAttribute(element, kAXSizeAttribute as CFString) {
        row["bounds"] = ["x": point.x, "y": point.y, "width": size.width, "height": size.height]
        if row["visible"] == nil { row["visible"] = size.width > 0 && size.height > 0 }
    }
    return row
}

func scanTop() -> [(AXUIElement, [String: Any])] {
    let system = AXUIElementCreateSystemWide()
    var result: [(AXUIElement, [String: Any])] = []
    var seen = Set<String>()
    for screen in NSScreen.screens {
        let frame = screen.frame
        let minX = Int(frame.minX)
        let maxX = Int(frame.maxX)
        let minY = Int(frame.minY)
        for y in [minY + 4, minY + 10, minY + 16, minY + 22] {
            var x = minX + 2
            while x < maxX - 2 {
                var element: AXUIElement?
                if AXUIElementCopyElementAtPosition(system, Float(x), Float(y), &element) == .success,
                   let element {
                    let row = describe(element, pid: nil)
                    let bounds = row["bounds"] as? [String: Any] ?? [:]
                    let key = "\(row["pid"] ?? "")|\(row["role"] ?? "")|\(row["title"] ?? "")|\(row["description"] ?? "")|\(bounds["x"] ?? "")|\(bounds["y"] ?? "")|\(bounds["width"] ?? "")|\(bounds["height"] ?? "")"
                    if !seen.contains(key) {
                        seen.insert(key)
                        result.append((element, row))
                    }
                }
                x += 2
            }
        }
    }
    return result
}

func matches(_ row: [String: Any], selector: String) -> Bool {
    ["title", "description", "roleDescription"].contains { row[$0] as? String == selector }
}

func press(selector: String) throws -> [String: Any] {
    for (element, row) in scanTop() where matches(row, selector: selector) {
        let error = AXUIElementPerformAction(element, kAXPressAction as CFString)
        guard error == .success else { throw ProbeError.operationFailed("AXPress failed with code \(error.rawValue)") }
        return row
    }
    throw ProbeError.operationFailed("no top-level system element matched selector")
}

func pressPID(_ targetPID: pid_t) throws -> [String: Any] {
    for (element, row) in scanTop()
    where row["pid"] as? Int32 == targetPID && row["subrole"] as? String == "AXMenuExtra" {
        let error = AXUIElementPerformAction(element, kAXPressAction as CFString)
        guard error == .success else { throw ProbeError.operationFailed("AXPress failed with code \(error.rawValue)") }
        return row
    }
    throw ProbeError.operationFailed("no status item matched pid")
}

func clickPoint(_ point: CGPoint) throws {
    guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left),
          let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
          let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
        throw ProbeError.operationFailed("failed to construct mouse events")
    }
    move.post(tap: .cghidEventTap)
    usleep(50_000)
    down.post(tap: .cghidEventTap)
    usleep(50_000)
    up.post(tap: .cghidEventTap)
}

func clickPID(_ targetPID: pid_t) throws -> [String: Any] {
    for (_, row) in scanTop()
    where row["pid"] as? Int32 == targetPID && row["subrole"] as? String == "AXMenuExtra" {
        guard let bounds = row["bounds"] as? [String: Any],
              let x = bounds["x"] as? CGFloat,
              let y = bounds["y"] as? CGFloat,
              let width = bounds["width"] as? CGFloat,
              let height = bounds["height"] as? CGFloat else {
            throw ProbeError.operationFailed("status item bounds unavailable")
        }
        try clickPoint(CGPoint(x: x + width / 2, y: y + height / 2))
        return row
    }
    throw ProbeError.operationFailed("no status item matched pid")
}

func postCmdQ() throws {
    let source = CGEventSource(stateID: .combinedSessionState)
    guard let down = CGEvent(keyboardEventSource: source, virtualKey: 12, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: 12, keyDown: false) else {
        throw ProbeError.operationFailed("failed to construct Cmd+Q events")
    }
    down.flags = .maskCommand
    up.flags = .maskCommand
    down.post(tap: .cghidEventTap)
    usleep(50_000)
    up.post(tap: .cghidEventTap)
}

func activateWithoutShowingWindows(_ targetPID: pid_t) throws {
    guard let application = NSRunningApplication(processIdentifier: targetPID) else {
        throw ProbeError.operationFailed("target application is not running")
    }
    guard application.activate(options: []) else {
        throw ProbeError.operationFailed("target application activation failed")
    }
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard let command = arguments.first else { throw ProbeError.invalidArguments("missing command") }
    switch command {
    case "scan-top":
        try emitJSON(scanTop().map { $0.1 })
    case "press":
        guard arguments.count == 2 else { throw ProbeError.invalidArguments("press requires exact selector") }
        try emitJSON(press(selector: arguments[1]))
    case "press-pid":
        guard arguments.count == 2, let targetPID = Int32(arguments[1]), targetPID > 0 else {
            throw ProbeError.invalidArguments("press-pid requires a positive pid")
        }
        try emitJSON(pressPID(targetPID))
    case "click-pid":
        guard arguments.count == 2, let targetPID = Int32(arguments[1]), targetPID > 0 else {
            throw ProbeError.invalidArguments("click-pid requires a positive pid")
        }
        try emitJSON(clickPID(targetPID))
    case "cmdq":
        guard arguments.count == 3,
              let targetPID = Int32(arguments[1]), targetPID > 0,
              let delayMs = UInt32(arguments[2]), delayMs <= 10_000 else {
            throw ProbeError.invalidArguments("cmdq requires pid and delay milliseconds from 0 to 10000")
        }
        let firstAt = DispatchTime.now().uptimeNanoseconds
        try postCmdQ()
        // 首次 Cmd+Q 会隐藏窗口，先在目标窗口仍处于确认窗口内重新激活应用，
        // 再把第二个事件投递给同一个应用，避免事件落到当前前台的其它应用。
        let leadMilliseconds = min(UInt32(150), delayMs)
        if delayMs > leadMilliseconds { usleep((delayMs - leadMilliseconds) * 1000) }
        try activateWithoutShowingWindows(targetPID)
        // 系统事件从 CGEvent 队列到 Tauri 菜单分发存在调度抖动；边界类用例在
        // 2000ms 上增加最小安全余量，确保被测应用看到的是“已过窗口”，而不是
        // 因首个事件尚未入队造成的假阴性。1999ms 保持原始窗口内语义。
        let boundaryPaddingMs: UInt32 = delayMs >= 2_000 ? 250 : 0
        let targetNanoseconds = firstAt + UInt64(delayMs + boundaryPaddingMs) * 1_000_000
        while DispatchTime.now().uptimeNanoseconds < targetNanoseconds {
            let remaining = targetNanoseconds - DispatchTime.now().uptimeNanoseconds
            usleep(UInt32(min(remaining / 1_000, 5_000)))
        }
        let secondAt = DispatchTime.now().uptimeNanoseconds
        try postCmdQ()
        try emitJSON([
            "ok": true,
            "delayMs": delayMs,
            "boundaryPaddingMs": boundaryPaddingMs,
            "observedDelayMs": Double(secondAt - firstAt) / 1_000_000.0,
        ])
    default:
        throw ProbeError.invalidArguments("unknown command")
    }
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(2)
}
