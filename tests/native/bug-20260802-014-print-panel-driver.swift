import ApplicationServices
import AppKit
import CoreGraphics
import Foundation

enum DriverError: Error, CustomStringConvertible {
    case invalid(String)
    case failed(String)

    var description: String {
        switch self {
        case .invalid(let message), .failed(let message): return message
        }
    }
}

func emit(_ value: Any) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    guard let text = String(data: data, encoding: .utf8) else {
        throw DriverError.failed("JSON encoding failed")
    }
    print(text)
}

func parsePID(_ raw: String) throws -> pid_t {
    guard let pid = Int32(raw), pid > 0 else { throw DriverError.invalid("pid must be positive") }
    return pid
}

func copyAttribute(_ element: AXUIElement, _ attribute: CFString) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
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

func children(_ element: AXUIElement) -> [AXUIElement] {
    (copyAttribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement]) ?? []
}

func describe(_ element: AXUIElement, depth: Int) -> [String: Any] {
    var row: [String: Any] = ["depth": depth]
    if let value = stringAttribute(element, kAXRoleAttribute as CFString) { row["role"] = value }
    if let value = stringAttribute(element, kAXSubroleAttribute as CFString) { row["subrole"] = value }
    if let value = stringAttribute(element, kAXTitleAttribute as CFString), !value.isEmpty { row["title"] = value }
    if let value = stringAttribute(element, kAXDescriptionAttribute as CFString), !value.isEmpty { row["description"] = value }
    if let value = stringAttribute(element, kAXValueAttribute as CFString), !value.isEmpty { row["value"] = value }
    if let value = boolAttribute(element, kAXEnabledAttribute as CFString) { row["enabled"] = value }
    if let value = boolAttribute(element, kAXFocusedAttribute as CFString) { row["focused"] = value }
    if let position = pointAttribute(element, kAXPositionAttribute as CFString),
       let size = sizeAttribute(element, kAXSizeAttribute as CFString) {
        row["bounds"] = [
            "x": Double(position.x), "y": Double(position.y),
            "width": Double(size.width), "height": Double(size.height),
        ]
    }
    return row
}

func walk(_ root: AXUIElement, maxDepth: Int = 14, maxCount: Int = 5000) -> [(AXUIElement, [String: Any])] {
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var rows: [(AXUIElement, [String: Any])] = []
    var index = 0
    while index < queue.count && rows.count < maxCount {
        let (element, depth) = queue[index]
        index += 1
        rows.append((element, describe(element, depth: depth)))
        if depth < maxDepth {
            queue.append(contentsOf: children(element).map { ($0, depth + 1) })
        }
    }
    return rows
}

func windowRows(pid: pid_t) -> [[String: Any]] {
    let options: CGWindowListOption = [.excludeDesktopElements, .optionOnScreenOnly]
    let rows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
    return rows.compactMap { row in
        guard (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid else { return nil }
        let bounds = row[kCGWindowBounds as String] as? [String: Any] ?? [:]
        return [
            "id": (row[kCGWindowNumber as String] as? NSNumber)?.intValue ?? -1,
            "layer": (row[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1,
            "alpha": (row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0,
            "name": row[kCGWindowName as String] as? String ?? "",
            "owner": row[kCGWindowOwnerName as String] as? String ?? "",
            "bounds": [
                "x": ((bounds["X"] as? NSNumber)?.doubleValue ?? 0) as Double,
                "y": ((bounds["Y"] as? NSNumber)?.doubleValue ?? 0) as Double,
                "width": ((bounds["Width"] as? NSNumber)?.doubleValue ?? 0) as Double,
                "height": ((bounds["Height"] as? NSNumber)?.doubleValue ?? 0) as Double,
            ],
        ]
    }
}

func matches(_ row: [String: Any], exact: Set<String>) -> Bool {
    for key in ["title", "description", "value"] {
        if let value = row[key] as? String, exact.contains(value) { return true }
    }
    return false
}

func uniqueEnabled(pid: pid_t, exact: Set<String>, roles: Set<String>) throws -> (AXUIElement, [String: Any]) {
    let root = AXUIElementCreateApplication(pid)
    var seen = Set<Int>()
    let found = walk(root).compactMap { element, row -> (AXUIElement, [String: Any])? in
        let role = row["role"] as? String ?? ""
        guard roles.contains(role) && row["enabled"] as? Bool != false && matches(row, exact: exact) else { return nil }
        // AppKit 菜单项可能同时挂在菜单和弹出菜单两个 AX 父节点下；按 AX 对象去重，避免同一实体被误判为歧义。
        guard seen.insert(Int(CFHash(element as CFTypeRef))).inserted else { return nil }
        return (element, row)
    }
    guard found.count == 1 else {
        throw DriverError.failed("expected one exact enabled AX target, found \(found.count): \(Array(exact).sorted())")
    }
    return found[0]
}

func press(pid: pid_t, exact: Set<String>, roles: Set<String>) throws -> [String: Any] {
    let (element, row) = try uniqueEnabled(pid: pid, exact: exact, roles: roles)
    let result = AXUIElementPerformAction(element, kAXPressAction as CFString)
    guard result == .success else { throw DriverError.failed("AXPress failed: \(result.rawValue)") }
    return row
}

func pressDeepest(pid: pid_t, exact: Set<String>, roles: Set<String>) throws -> [String: Any] {
    let root = AXUIElementCreateApplication(pid)
    var seen = Set<Int>()
    let found = walk(root).compactMap { element, row -> (AXUIElement, [String: Any])? in
        let role = row["role"] as? String ?? ""
        guard roles.contains(role) && row["enabled"] as? Bool != false && matches(row, exact: exact) else { return nil }
        guard seen.insert(Int(CFHash(element as CFTypeRef))).inserted else { return nil }
        return (element, row)
    }
    guard let selected = found.max(by: { ($0.1["depth"] as? Int ?? 0) < ($1.1["depth"] as? Int ?? 0) }) else {
        throw DriverError.failed("expected enabled AX target, found 0: \(Array(exact).sorted())")
    }
    let result = AXUIElementPerformAction(selected.0, kAXPressAction as CFString)
    guard result == .success else { throw DriverError.failed("AXPress failed: \(result.rawValue)") }
    return selected.1
}

func setSafePDFName(pid: pid_t, name: String) throws -> [String: Any] {
    let regex = try NSRegularExpression(pattern: "^[A-Za-z0-9._-]+\\.pdf$")
    let range = NSRange(name.startIndex..<name.endIndex, in: name)
    guard regex.firstMatch(in: name, range: range)?.range == range else {
        throw DriverError.invalid("save name must be a leaf .pdf filename")
    }
    let root = AXUIElementCreateApplication(pid)
    var fields = walk(root).filter { _, row in
        guard row["role"] as? String == (kAXTextFieldRole as String), row["enabled"] as? Bool != false else { return false }
        let values = [row["title"], row["description"], row["value"]].compactMap { $0 as? String }
        return values.contains { value in
            value.localizedCaseInsensitiveContains("save as") ||
                value.contains("存储为") || value.contains("另存为") || value.contains("保存为") || value.lowercased().hasSuffix(".pdf")
        }
    }
    if fields.isEmpty {
        // 中文 macOS 只把“保存为：”作为相邻静态文本，文件名输入框本身只有“未命名”值；
        // NSSavePanel 打开后该字段是唯一焦点文本框，仍保持叶文件名与沙盒目标约束。
        fields = walk(root).filter { _, row in
            row["role"] as? String == (kAXTextFieldRole as String) &&
                row["enabled"] as? Bool != false && row["focused"] as? Bool == true
        }
    }
    guard fields.count == 1 else {
        throw DriverError.failed("expected one Save As text field, found \(fields.count)")
    }
    let result = AXUIElementSetAttributeValue(fields[0].0, kAXValueAttribute as CFString, name as CFTypeRef)
    guard result == .success else { throw DriverError.failed("setting safe PDF leaf name failed: \(result.rawValue)") }
    return fields[0].1
}

// BUG013 复用同一 NSSavePanel AX 驱动，但允许隔离文件导出使用的非 PDF 叶名。
func setSafeSaveName(pid: pid_t, name: String) throws -> [String: Any] {
    let regex = try NSRegularExpression(pattern: "^[A-Za-z0-9._ -]+$")
    let range = NSRange(name.startIndex..<name.endIndex, in: name)
    guard !name.isEmpty, regex.firstMatch(in: name, range: range)?.range == range else {
        throw DriverError.invalid("save name contains unsupported characters")
    }
    let root = AXUIElementCreateApplication(pid)
    var fields = walk(root).filter { _, row in
        guard row["role"] as? String == (kAXTextFieldRole as String), row["enabled"] as? Bool != false else { return false }
        let values = [row["title"], row["description"], row["value"]].compactMap { $0 as? String }
        return values.contains { value in
            value.localizedCaseInsensitiveContains("save as") ||
                value.contains("存储为") || value.contains("另存为") || value.contains("保存为")
        }
    }
    if fields.isEmpty {
        fields = walk(root).filter { _, row in
            row["role"] as? String == (kAXTextFieldRole as String) &&
                row["enabled"] as? Bool != false && row["focused"] as? Bool == true
        }
    }
    guard fields.count == 1 else {
        throw DriverError.failed("expected one Save text field, found \(fields.count)")
    }
    let result = AXUIElementSetAttributeValue(fields[0].0, kAXValueAttribute as CFString, name as CFTypeRef)
    guard result == .success else { throw DriverError.failed("setting Save leaf name failed: \(result.rawValue)") }
    return fields[0].1
}

func activate(pid: pid_t) throws {
    guard let application = NSRunningApplication(processIdentifier: pid),
          application.activate(options: [.activateAllWindows]) else {
        throw DriverError.failed("application activation failed")
    }
}

func postKey(_ keyCode: CGKeyCode, flags: CGEventFlags = []) throws {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else {
        throw DriverError.failed("keyboard event creation failed")
    }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}

func focusedTextField(pid: pid_t) -> (AXUIElement, [String: Any])? {
    let root = AXUIElementCreateApplication(pid)
    return walk(root).first { _, row in
        row["role"] as? String == (kAXTextFieldRole as String) &&
            row["enabled"] as? Bool != false && row["focused"] as? Bool == true
    }
}

func selectSafeDirectory(pid: pid_t, path: String) throws -> [String: Any] {
    guard path.hasPrefix("/") && !path.contains("\n") else { throw DriverError.invalid("directory must be an absolute path") }
    let root = AXUIElementCreateApplication(pid)
    let location = walk(root).filter { _, row in
        guard row["role"] as? String == (kAXPopUpButtonRole as String) else { return false }
        let values = [row["title"], row["description"], row["value"]].compactMap { $0 as? String }
        return values.contains { value in
            value.contains("位置") || value.localizedCaseInsensitiveContains("location")
        }
    }
    guard location.count == 1 else { throw DriverError.failed("expected one Save location popup, found \(location.count)") }
    let openResult = AXUIElementPerformAction(location[0].0, kAXPressAction as CFString)
    guard openResult == .success else { throw DriverError.failed("opening Save location menu failed: \(openResult.rawValue)") }
    Thread.sleep(forTimeInterval: 0.25)

    let menuRoot = AXUIElementCreateApplication(pid)
    let other = walk(menuRoot).filter { _, row in
        let role = row["role"] as? String ?? ""
        let title = [row["title"], row["description"], row["value"]].compactMap { $0 as? String }.joined(separator: " ")
        return role == (kAXMenuItemRole as String) &&
            ["Other…", "Other...", "其他…", "其他...", "选择其他…", "选择其他..."].contains(title)
    }
    if other.count != 1 {
        let labels = walk(menuRoot).compactMap { _, row -> String? in
            guard row["role"] as? String == (kAXMenuItemRole as String) else { return nil }
            return [row["title"], row["description"], row["value"]].compactMap { $0 as? String }.joined(separator: "|")
        }.filter { !$0.isEmpty }
        let popupRows = walk(location[0].0, maxDepth: 6).compactMap { _, row -> String? in
            let values = [row["role"], row["title"], row["description"], row["value"]].compactMap { $0 as? String }
            return values.isEmpty ? nil : values.joined(separator: "|")
        }
        // 该 macOS 版本的位置菜单没有 Other 项，但 Save 面板仍支持标准 Cmd+Shift+G 路径入口。
        _ = labels
        _ = popupRows
        try postKey(53)
        Thread.sleep(forTimeInterval: 0.2)
        try postKey(5, flags: [.maskCommand, .maskShift])
        Thread.sleep(forTimeInterval: 0.35)
    } else {
        let otherResult = AXUIElementPerformAction(other[0].0, kAXPressAction as CFString)
        guard otherResult == .success else { throw DriverError.failed("opening Other location sheet failed: \(otherResult.rawValue)") }
        Thread.sleep(forTimeInterval: 0.35)
    }

    if focusedTextField(pid: pid) == nil {
        // Other… 在不同 macOS 版本可能先进入文件夹选择 sheet，再由 Cmd+Shift+G 打开路径输入。
        try postKey(5, flags: [.maskCommand, .maskShift])
        Thread.sleep(forTimeInterval: 0.35)
    }
    guard let field = focusedTextField(pid: pid) else {
        throw DriverError.failed("Save location path field is not focused")
    }
    let setResult = AXUIElementSetAttributeValue(field.0, kAXValueAttribute as CFString, path as CFTypeRef)
    guard setResult == .success else { throw DriverError.failed("setting Save location path failed: \(setResult.rawValue)") }
    try postKey(36)
    return field.1
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard let command = arguments.first else { throw DriverError.invalid("missing command") }
    switch command {
    case "preflight":
        try emit(["accessibility": AXIsProcessTrusted(), "screenCapture": CGPreflightScreenCaptureAccess()])
    case "ax":
        guard arguments.count == 2 else { throw DriverError.invalid("ax requires pid") }
        try emit(walk(AXUIElementCreateApplication(try parsePID(arguments[1]))).map { $0.1 })
    case "windows":
        guard arguments.count == 2 else { throw DriverError.invalid("windows requires pid") }
        try emit(windowRows(pid: try parsePID(arguments[1])))
    case "activate":
        guard arguments.count == 2 else { throw DriverError.invalid("activate requires pid") }
        try activate(pid: try parsePID(arguments[1])); try emit(["ok": true])
    case "cancel-print-panel":
        guard arguments.count == 2 else { throw DriverError.invalid("cancel-print-panel requires pid") }
        try emit(pressDeepest(pid: try parsePID(arguments[1]), exact: ["Cancel", "取消"], roles: [kAXButtonRole as String]))
    case "open-pdf-menu":
        guard arguments.count == 2 else { throw DriverError.invalid("open-pdf-menu requires pid") }
        // AppKit 将 PDF 分段控件同时暴露为 AXButton 与 AXMenuButton；只点击后者，避免把左侧标签段误判为菜单。
        try emit(press(pid: try parsePID(arguments[1]), exact: ["PDF"], roles: [kAXMenuButtonRole as String]))
    case "choose-save-as-pdf":
        guard arguments.count == 2 else { throw DriverError.invalid("choose-save-as-pdf requires pid") }
        try emit(press(pid: try parsePID(arguments[1]), exact: ["Save as PDF…", "Save as PDF...", "存储为 PDF…", "存储为 PDF...", "另存为 PDF…", "另存为 PDF...", "保存为PDF…", "保存为PDF...", "保存为 PDF…", "保存为 PDF..."], roles: [kAXMenuItemRole as String]))
    case "set-safe-pdf-name":
        guard arguments.count == 3 else { throw DriverError.invalid("set-safe-pdf-name requires pid and leaf filename") }
        try emit(setSafePDFName(pid: try parsePID(arguments[1]), name: arguments[2]))
    case "set-safe-save-name":
        guard arguments.count == 3 else { throw DriverError.invalid("set-safe-save-name requires pid and leaf filename") }
        try emit(setSafeSaveName(pid: try parsePID(arguments[1]), name: arguments[2]))
    case "select-safe-directory":
        guard arguments.count == 3 else { throw DriverError.invalid("select-safe-directory requires pid and absolute path") }
        try emit(selectSafeDirectory(pid: try parsePID(arguments[1]), path: arguments[2]))
    case "confirm-save-pdf":
        guard arguments.count == 2 else { throw DriverError.invalid("confirm-save-pdf requires pid") }
        try emit(pressDeepest(pid: try parsePID(arguments[1]), exact: ["Save", "存储", "保存"], roles: [kAXButtonRole as String]))
    case "confirm-save":
        guard arguments.count == 2 else { throw DriverError.invalid("confirm-save requires pid") }
        try emit(pressDeepest(pid: try parsePID(arguments[1]), exact: ["Save", "存储", "保存"], roles: [kAXButtonRole as String]))
    default:
        throw DriverError.invalid("unsupported command")
    }
} catch {
    fputs("\(error)\n", stderr)
    exit(2)
}
