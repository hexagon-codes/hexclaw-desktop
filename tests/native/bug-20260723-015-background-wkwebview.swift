import AppKit
import Darwin
import Foundation
import WebKit

private struct ProbeState {
  let id: String
  let mode: String
  let theme: String
}

private enum ProbePhase: String {
  case reference
  case implementation
}

private let states = [
  ProbeState(id: "normal-light", mode: "normal", theme: "light"),
  ProbeState(id: "normal-dark", mode: "normal", theme: "dark"),
  ProbeState(id: "k12-light", mode: "k12", theme: "light"),
  ProbeState(id: "k12-dark", mode: "k12", theme: "dark"),
]

private let referenceCandidates: [[String: String]] = [
  ["id": "app-before", "selector": ".app", "pseudo": "::before"],
  ["id": "app-after", "selector": ".app", "pseudo": "::after"],
  ["id": "main-before", "selector": ".mn", "pseudo": "::before"],
  ["id": "main-after", "selector": ".mn", "pseudo": "::after"],
  ["id": "main-glow", "selector": ".mn-glow"],
  ["id": "main-glow-before", "selector": ".mn-glow", "pseudo": "::before"],
  ["id": "main-glow-after", "selector": ".mn-glow", "pseudo": "::after"],
]

private let implementationCandidates: [[String: String]] = [
  ["id": "app-before", "selector": ".hc-app", "pseudo": "::before"],
  ["id": "app-after", "selector": ".hc-app", "pseudo": "::after"],
  ["id": "body-before", "selector": ".hc-app__body", "pseudo": "::before"],
  ["id": "body-after", "selector": ".hc-app__body", "pseudo": "::after"],
  ["id": "content-before", "selector": ".hc-app__content", "pseudo": "::before"],
  ["id": "content-after", "selector": ".hc-app__content", "pseudo": "::after"],
  ["id": "main-glow", "selector": ".hc-app__glow"],
  ["id": "main-glow-before", "selector": ".hc-app__glow", "pseudo": "::before"],
  ["id": "main-glow-after", "selector": ".hc-app__glow", "pseudo": "::after"],
]

private func fail(_ message: String, status: Int32 = 1) -> Never {
  FileHandle.standardError.write(Data("\(message)\n".utf8))
  Foundation.exit(status)
}

private func jsonLiteral(_ value: Any) -> String {
  guard
    let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
    let result = String(data: data, encoding: .utf8)
  else {
    fail("Unable to serialize JavaScript input")
  }
  return result
}

private func pngData(_ image: NSImage) -> Data? {
  guard
    let tiff = image.tiffRepresentation,
    let bitmap = NSBitmapImageRep(data: tiff)
  else { return nil }
  return bitmap.representation(using: .png, properties: [:])
}

private func rgbaPixels(_ url: URL) throws -> (width: Int, height: Int, pixels: [UInt8]) {
  guard let image = NSImage(contentsOf: url) else {
    throw NSError(domain: "BUG015", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unable to read \(url.lastPathComponent)"])
  }
  var proposed = NSRect(origin: .zero, size: image.size)
  guard let cgImage = image.cgImage(forProposedRect: &proposed, context: nil, hints: nil) else {
    throw NSError(domain: "BUG015", code: 2, userInfo: [NSLocalizedDescriptionKey: "Unable to decode \(url.lastPathComponent)"])
  }
  let width = cgImage.width
  let height = cgImage.height
  var pixels = [UInt8](repeating: 0, count: width * height * 4)
  let colorSpace = CGColorSpaceCreateDeviceRGB()
  let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue
  let created = pixels.withUnsafeMutableBytes { bytes -> Bool in
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
    context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
    return true
  }
  guard created else {
    throw NSError(domain: "BUG015", code: 3, userInfo: [NSLocalizedDescriptionKey: "Unable to rasterize \(url.lastPathComponent)"])
  }
  return (width, height, pixels)
}

private func writeRGBA(_ pixels: [UInt8], width: Int, height: Int, to url: URL) throws {
  guard
    let bitmap = NSBitmapImageRep(
      bitmapDataPlanes: nil,
      pixelsWide: width,
      pixelsHigh: height,
      bitsPerSample: 8,
      samplesPerPixel: 4,
      hasAlpha: true,
      isPlanar: false,
      colorSpaceName: .deviceRGB,
      bytesPerRow: width * 4,
      bitsPerPixel: 32
    ),
    let destination = bitmap.bitmapData
  else {
    throw NSError(domain: "BUG015", code: 4, userInfo: [NSLocalizedDescriptionKey: "Unable to allocate diff bitmap"])
  }
  _ = pixels.withUnsafeBytes { source in
    memcpy(destination, source.baseAddress!, pixels.count)
  }
  guard let png = bitmap.representation(using: .png, properties: [:]) else {
    throw NSError(domain: "BUG015", code: 5, userInfo: [NSLocalizedDescriptionKey: "Unable to encode diff PNG"])
  }
  try png.write(to: url, options: .atomic)
}

private func pixelDiff(reference: URL, implementation: URL, output: URL) throws -> [String: Any] {
  let left = try rgbaPixels(reference)
  let right = try rgbaPixels(implementation)
  guard left.width == right.width, left.height == right.height else {
    throw NSError(domain: "BUG015", code: 6, userInfo: [NSLocalizedDescriptionKey: "Paired screenshots have different dimensions"])
  }
  let threshold = 8
  var changed = 0
  var minX = left.width
  var minY = left.height
  var maxX = -1
  var maxY = -1
  var visible = [UInt8](repeating: 255, count: left.pixels.count)
  for offset in stride(from: 0, to: left.pixels.count, by: 4) {
    let isChanged =
      abs(Int(left.pixels[offset]) - Int(right.pixels[offset])) > threshold
      || abs(Int(left.pixels[offset + 1]) - Int(right.pixels[offset + 1])) > threshold
      || abs(Int(left.pixels[offset + 2]) - Int(right.pixels[offset + 2])) > threshold
    let pixel = offset / 4
    let x = pixel % left.width
    let y = pixel / left.width
    if isChanged {
      changed += 1
      minX = min(minX, x)
      minY = min(minY, y)
      maxX = max(maxX, x)
      maxY = max(maxY, y)
      visible[offset] = 255
      visible[offset + 1] = 35
      visible[offset + 2] = 35
    } else {
      let gray = Int(
        Double(left.pixels[offset]) * 0.299
          + Double(left.pixels[offset + 1]) * 0.587
          + Double(left.pixels[offset + 2]) * 0.114
      )
      let dimmed = UInt8(max(0, min(255, Int(Double(gray) * 0.45))))
      visible[offset] = dimmed
      visible[offset + 1] = dimmed
      visible[offset + 2] = dimmed
    }
    visible[offset + 3] = 255
  }
  try writeRGBA(visible, width: left.width, height: left.height, to: output)
  let total = left.width * left.height
  return [
    "width": left.width,
    "height": left.height,
    "threshold": threshold,
    "changedPixels": changed,
    "totalPixels": total,
    "changedPixelRatio": Double(changed) / Double(total),
    "changedBBox": changed == 0 ? NSNull() : [minX, minY, maxX + 1, maxY + 1],
  ]
}

private final class BackgroundProbe: NSObject, WKNavigationDelegate {
  private let resourceRoot: URL
  private let outputRoot: URL
  private let webView: WKWebView
  private var stateIndex = 0
  private var phase = ProbePhase.reference
  private var measurements: [String: [String: Any]] = [:]
  private var stateReports: [[String: Any]] = []
  private var blockedNavigations: [String] = []
  private var contentRuleInstalled = false

  init(resourceRoot: URL, outputRoot: URL) {
    self.resourceRoot = resourceRoot
    self.outputRoot = outputRoot
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    webView = WKWebView(
      frame: NSRect(x: 0, y: 0, width: 1440, height: 900),
      configuration: configuration
    )
    super.init()
    webView.navigationDelegate = self
  }

  func start() {
    let rules = #"[{"trigger":{"url-filter":"^https?://.*"},"action":{"type":"block"}}]"#
    WKContentRuleListStore.default().compileContentRuleList(
      forIdentifier: "com.hexclaw.desktop.bug015.background.network-block",
      encodedContentRuleList: rules
    ) { [weak self] ruleList, error in
      guard let self else { return }
      if let error { fail("Unable to install HTTP content blocker: \(error)") }
      guard let ruleList else { fail("HTTP content blocker returned no rule list") }
      self.webView.configuration.userContentController.add(ruleList)
      self.contentRuleInstalled = true
      self.loadCurrentDocument()
    }
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = navigationAction.request.url else {
      decisionHandler(.cancel)
      return
    }
    if url.isFileURL || ["about", "data"].contains(url.scheme ?? "") {
      decisionHandler(.allow)
    } else {
      blockedNavigations.append("\(url.scheme ?? "unknown")://blocked")
      decisionHandler(.cancel)
    }
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    fail("WKWebView navigation failed: \(error)")
  }

  func webView(
    _ webView: WKWebView,
    didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    fail("WKWebView provisional navigation failed: \(error)")
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
      self?.prepareAndCapture()
    }
  }

  private var currentState: ProbeState { states[stateIndex] }

  private func loadCurrentDocument() {
    let relative = phase == .reference ? "reference/app.html" : "implementation/index.html"
    let document = resourceRoot.appendingPathComponent(relative)
    guard FileManager.default.fileExists(atPath: document.path) else {
      fail("Packaged document is missing: \(relative)")
    }
    webView.loadFileURL(document, allowingReadAccessTo: resourceRoot)
  }

  private func prepareScript(_ state: ProbeState) -> String {
    let theme = jsonLiteral(state.theme)
    let mode = jsonLiteral(state.mode)
    return #"""
    (() => {
      const theme = \#(theme);
      const mode = \#(mode);
      window.__bug015RuntimeErrors = [];
      window.addEventListener('error', event => window.__bug015RuntimeErrors.push(String(event.error || event.message)));
      window.addEventListener('unhandledrejection', event => window.__bug015RuntimeErrors.push(String(event.reason)));
      if (typeof window.applyThemeState === 'function') window.applyThemeState(theme, false);
      document.documentElement.setAttribute('data-theme', theme);
      document.documentElement.lang = 'zh-CN';
      if (mode === 'k12') document.body.setAttribute('data-k12-skin-active', 'k12');
      else document.body.removeAttribute('data-k12-skin-active');
      document.querySelector('#bug015-native-normalized-plane')?.remove();
      let stabilizer = document.querySelector('#bug015-native-stabilizer');
      if (!stabilizer) {
        stabilizer = document.createElement('style');
        stabilizer.id = 'bug015-native-stabilizer';
        stabilizer.textContent = `
          *, *::before, *::after {
            animation: none !important;
            caret-color: transparent !important;
            transition: none !important;
          }
          html { scroll-behavior: auto !important; }
        `;
        document.head.append(stabilizer);
      }
      window.scrollTo(0, 0);
      return true;
    })()
    """#
  }

  private func measurementScript(candidates: [[String: String]]) -> String {
    let items = jsonLiteral(candidates)
    return #"""
    (() => {
      const candidates = \#(items);
      const round = value => Math.round(value * 100) / 100;
      const layers = candidates.map(candidate => {
        const element = document.querySelector(candidate.selector);
        if (!element) return {...candidate, found: false, active: false, kind: 'none'};
        const style = getComputedStyle(element, candidate.pseudo || null);
        const backgroundImage = style.backgroundImage;
        const pseudoPainted = !candidate.pseudo || !['none', 'normal', ''].includes(style.content);
        const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0;
        const active = pseudoPainted && visible && backgroundImage !== 'none';
        const kind = backgroundImage.includes('image/svg+xml')
          ? 'texture'
          : backgroundImage.includes('radial-gradient')
            ? 'glow'
            : backgroundImage === 'none' ? 'none' : 'other';
        const rect = element.getBoundingClientRect();
        return {
          ...candidate,
          found: true,
          active,
          kind,
          rect: {x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height)},
          style: {
            content: style.content,
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            backgroundColor: style.backgroundColor,
            backgroundImage,
            backgroundPosition: style.backgroundPosition,
            backgroundSize: style.backgroundSize,
            backgroundRepeat: style.backgroundRepeat,
            backgroundBlendMode: style.backgroundBlendMode,
            mixBlendMode: style.mixBlendMode,
            position: style.position,
            inset: style.inset,
            top: style.top,
            right: style.right,
            bottom: style.bottom,
            left: style.left,
            width: style.width,
            height: style.height,
            zIndex: style.zIndex,
            pointerEvents: style.pointerEvents,
          },
        };
      });
      const mainSelector = document.querySelector('.mn') ? '.mn' : '.hc-app__content';
      const main = document.querySelector(mainSelector);
      const mainStyle = main ? getComputedStyle(main) : null;
      const mainRect = main?.getBoundingClientRect();
      return JSON.stringify({
        layers,
        main: main && mainStyle && mainRect ? {
          selector: mainSelector,
          rect: {x: round(mainRect.x), y: round(mainRect.y), width: round(mainRect.width), height: round(mainRect.height)},
          style: {borderLeftWidth: mainStyle.borderLeftWidth, zIndex: mainStyle.zIndex},
        } : null,
        environment: {
          viewport: {width: innerWidth, height: innerHeight},
          devicePixelRatio,
          locale: navigator.language,
          theme: document.documentElement.getAttribute('data-theme'),
          k12: document.body.getAttribute('data-k12-skin-active'),
        },
        runtimeErrors: window.__bug015RuntimeErrors || [],
      });
    })()
    """#
  }

  private func normalizedPlaneScript(_ phase: ProbePhase, theme: String) -> String {
    let textureSelector = phase == .reference ? ".app" : ".hc-app__body"
    let texturePseudo = "::after"
    let glowSelector = phase == .reference ? ".mn-glow" : ".hc-app__glow"
    return #"""
    (() => {
      document.querySelector('#bug015-native-normalized-plane')?.remove();
      const texture = getComputedStyle(document.querySelector('\#(textureSelector)'), '\#(texturePseudo)');
      const glow = getComputedStyle(document.querySelector('\#(glowSelector)'));
      const plane = document.createElement('div');
      plane.id = 'bug015-native-normalized-plane';
      Object.assign(plane.style, {
        position: 'fixed', inset: '0 auto auto 0', width: '1000px', height: '620px',
        overflow: 'hidden', zIndex: '2147483647',
        background: '\#(theme)' === 'light' ? 'rgb(244, 248, 252)' : 'rgb(11, 21, 37)',
      });
      const textureNode = document.createElement('div');
      Object.assign(textureNode.style, {
        position: 'absolute', inset: '0', pointerEvents: 'none', opacity: texture.opacity,
        backgroundImage: texture.backgroundImage, backgroundSize: texture.backgroundSize,
        backgroundPosition: texture.backgroundPosition, backgroundRepeat: texture.backgroundRepeat,
        backgroundBlendMode: texture.backgroundBlendMode, mixBlendMode: texture.mixBlendMode,
      });
      const glowNode = document.createElement('div');
      Object.assign(glowNode.style, {
        position: 'absolute', inset: '0 0 auto 0', height: '220px', pointerEvents: 'none', opacity: glow.opacity,
        backgroundImage: glow.backgroundImage, backgroundSize: glow.backgroundSize,
        backgroundPosition: glow.backgroundPosition, backgroundRepeat: glow.backgroundRepeat,
        backgroundBlendMode: glow.backgroundBlendMode, mixBlendMode: glow.mixBlendMode,
      });
      plane.append(textureNode, glowNode);
      document.body.append(plane);
      return true;
    })()
    """#
  }

  private func evaluate(_ script: String, completion: @escaping (Any?) -> Void) {
    webView.evaluateJavaScript(script) { value, error in
      if let error { fail("WKWebView JavaScript failed: \(error)") }
      completion(value)
    }
  }

  private func snapshot(rect: NSRect, output: URL, completion: @escaping () -> Void) {
    let config = WKSnapshotConfiguration()
    config.rect = rect
    webView.takeSnapshot(with: config) { image, error in
      if let error { fail("WKWebView snapshot failed: \(error)") }
      guard let image, let data = pngData(image) else { fail("WKWebView snapshot could not be encoded") }
      do {
        try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: output, options: .atomic)
      } catch {
        fail("WKWebView snapshot could not be saved: \(error)")
      }
      completion()
    }
  }

  private func prepareAndCapture() {
    let state = currentState
    let stateDirectory = outputRoot.appendingPathComponent(state.id)
    let phaseName = phase.rawValue
    let candidates = phase == .reference ? referenceCandidates : implementationCandidates
    evaluate(prepareScript(state)) { [weak self] _ in
      guard let self else { return }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
        self.evaluate(self.measurementScript(candidates: candidates)) { [weak self] value in
          guard let self else { return }
          guard
            let json = value as? String,
            let data = json.data(using: .utf8),
            let measurement = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
          else { fail("WKWebView returned invalid computed-style evidence") }
          self.measurements[phaseName] = measurement
          let page = stateDirectory.appendingPathComponent("page-\(phaseName).png")
          self.snapshot(rect: self.webView.bounds, output: page) { [weak self] in
            guard let self else { return }
            self.evaluate(self.normalizedPlaneScript(self.phase, theme: state.theme)) { [weak self] _ in
              guard let self else { return }
              let normalized = stateDirectory.appendingPathComponent("\(phaseName).png")
              self.snapshot(
                rect: NSRect(x: 0, y: 0, width: 1000, height: 620),
                output: normalized
              ) { [weak self] in
                self?.completePhase()
              }
            }
          }
        }
      }
    }
  }

  private func completePhase() {
    if phase == .reference {
      phase = .implementation
      loadCurrentDocument()
      return
    }
    let state = currentState
    let stateDirectory = outputRoot.appendingPathComponent(state.id)
    do {
      let normalized = try pixelDiff(
        reference: stateDirectory.appendingPathComponent("reference.png"),
        implementation: stateDirectory.appendingPathComponent("implementation.png"),
        output: stateDirectory.appendingPathComponent("diff.png")
      )
      let page = try pixelDiff(
        reference: stateDirectory.appendingPathComponent("page-reference.png"),
        implementation: stateDirectory.appendingPathComponent("page-implementation.png"),
        output: stateDirectory.appendingPathComponent("page-diff.png")
      )
      stateReports.append([
        "state": state.id,
        "mode": state.mode,
        "theme": state.theme,
        "reference": measurements[ProbePhase.reference.rawValue] ?? [:],
        "implementation": measurements[ProbePhase.implementation.rawValue] ?? [:],
        "pixels": ["normalized": normalized, "rawPageDiagnostic": page],
      ])
    } catch {
      fail("Unable to create native paired pixel diff: \(error)")
    }
    measurements = [:]
    stateIndex += 1
    phase = .reference
    if stateIndex < states.count {
      loadCurrentDocument()
    } else {
      finish()
    }
  }

  private func finish() {
    let report: [String: Any] = [
      "boundary": "isolated temporary Test.app / non-persistent WKWebView",
      "bundleIdentifier": Bundle.main.bundleIdentifier ?? "",
      "contentRuleInstalled": contentRuleInstalled,
      "blockedNavigations": blockedNavigations,
      "states": stateReports,
    ]
    do {
      let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
      try data.write(to: outputRoot.appendingPathComponent("native-raw-report.json"), options: .atomic)
    } catch {
      fail("Unable to save native report: \(error)")
    }
    print("BUG-20260723-015 isolated Test.app WKWebView probe passed")
    Foundation.exit(0)
  }
}

let arguments = CommandLine.arguments
guard arguments.count == 3 else {
  fail("Usage: bug015-background-wkwebview <resource-root> <output-root>", status: 2)
}
let resourceRoot = URL(fileURLWithPath: arguments[1]).standardizedFileURL
let outputRoot = URL(fileURLWithPath: arguments[2]).standardizedFileURL
try? FileManager.default.createDirectory(at: outputRoot, withIntermediateDirectories: true)

let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
private let probe = BackgroundProbe(resourceRoot: resourceRoot, outputRoot: outputRoot)
probe.start()
withExtendedLifetime(probe) {
  application.run()
}
