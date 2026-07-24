import AppKit
import Foundation
import WebKit

private let measurementScript = #"""
(() => {
  const round = value => Math.round(value * 1000) / 1000;
  const rectJSON = rect => ({
    top: round(rect.top),
    right: round(rect.right),
    bottom: round(rect.bottom),
    left: round(rect.left),
    width: round(rect.width ?? rect.right - rect.left),
    height: round(rect.height ?? rect.bottom - rect.top),
  });

  const inspectVerticalInk = element => {
    if (!element) return { present: false, visibleRatio: 0 };
    const rect = element.getBoundingClientRect();
    let visibleTop = rect.top;
    let visibleBottom = rect.bottom;
    const clippingAncestors = [];
    for (
      let ancestor = element.parentElement;
      ancestor;
      ancestor = ancestor.parentElement
    ) {
      const overflowY = getComputedStyle(ancestor).overflowY;
      if (!['auto', 'clip', 'hidden', 'scroll'].includes(overflowY)) continue;
      const ancestorRect = ancestor.getBoundingClientRect();
      const clipTop = ancestorRect.top + ancestor.clientTop;
      const clipBottom = clipTop + ancestor.clientHeight;
      visibleTop = Math.max(visibleTop, clipTop);
      visibleBottom = Math.min(visibleBottom, clipBottom);
      clippingAncestors.push({
        element: ancestor.className || ancestor.tagName,
        overflowY,
        clipTop: round(clipTop),
        clipBottom: round(clipBottom),
      });
    }
    const visibleHeight = Math.max(0, visibleBottom - visibleTop);
    const visibleRatio =
      rect.height > 0.01
        ? Math.min(1, visibleHeight / rect.height)
        : visibleTop <= rect.top + 0.01 && visibleBottom >= rect.bottom - 0.01
          ? 1
          : 0;
    return {
      present: true,
      rect: rectJSON(rect),
      visibleRatio: round(visibleRatio),
      clippingAncestors,
    };
  };

  const hasDirectVisibleText = element => Array.from(element.childNodes).some(
    node =>
      node.nodeType === Node.TEXT_NODE
      && Boolean(node.textContent?.replace(/[\s\u200b]+/g, '')),
  );
  const isVisibleInkElement = element => {
    const tagName = element.tagName.toLowerCase();
    return (
      hasDirectVisibleText(element)
      || tagName === 'svg'
      || element.classList.contains('frac-line')
      || element.classList.contains('sqrt-line')
      || element.classList.contains('overline-line')
      || element.classList.contains('underline-line')
    );
  };
  const inspectInkGroup = root => {
    if (!root) {
      return { inkCount: 0, minimumVisibleRatio: 0, allVisible: false, ink: [] };
    }
    const elements = [root, ...root.querySelectorAll('*')].filter(isVisibleInkElement);
    const ink = elements.map(inspectVerticalInk);
    return {
      inkCount: ink.length,
      minimumVisibleRatio: round(
        ink.reduce((minimum, part) => Math.min(minimum, part.visibleRatio), 1),
      ),
      allVisible:
        ink.length > 0
        && ink.every(part => part.present && part.visibleRatio >= 0.999),
      ink,
    };
  };
  const directChildWithClass = (element, className) =>
    Array.from(element?.children ?? []).find(child => child.classList.contains(className));
  const directFractionVList = fraction => {
    const table = directChildWithClass(fraction, 'vlist-t');
    const row = directChildWithClass(table, 'vlist-r');
    return directChildWithClass(row, 'vlist');
  };
  const fractionDepth = fraction => {
    let depth = 1;
    for (
      let ancestor = fraction.parentElement;
      ancestor && !ancestor.classList.contains('hc-math-viewport');
      ancestor = ancestor.parentElement
    ) {
      if (ancestor.classList.contains('mfrac')) depth += 1;
    }
    return depth;
  };
  const inspectFraction = (fraction, index) => {
    const vlist = directFractionVList(fraction);
    const layers = vlist ? Array.from(vlist.children) : [];
    const denominator = inspectInkGroup(layers[0]);
    const line = inspectVerticalInk(layers[1]?.querySelector('.frac-line'));
    const numerator = inspectInkGroup(layers[2]);
    const minimumVisibleRatio = round(
      Math.min(
        denominator.minimumVisibleRatio,
        line.visibleRatio,
        numerator.minimumVisibleRatio,
      ),
    );
    return {
      index,
      depth: fractionDepth(fraction),
      denominator,
      line,
      numerator,
      minimumVisibleRatio,
      allPartsVisible:
        denominator.allVisible
        && line.present
        && line.visibleRatio >= 0.999
        && numerator.allVisible,
    };
  };

  const inspectViewport = viewport => {
    const style = getComputedStyle(viewport);
    const fontSize = parseFloat(style.fontSize) || 1;
    const shell = viewport.parentElement;
    return {
      id: viewport.dataset.probeViewport,
      isDirectChildOfShell: Boolean(shell?.matches('[data-math-shell]')),
      classifiedAsNeedingScroll: viewport.dataset.classificationNeeded === 'true',
      hasScrollableClass: viewport.classList.contains(
        'hc-math-viewport--scrollable',
      ),
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      tabIndex: viewport.tabIndex,
      paddingBlockStart: round(parseFloat(style.paddingBlockStart) || 0),
      paddingBlockEnd: round(parseFloat(style.paddingBlockEnd) || 0),
      paddingBlockStartEm: round((parseFloat(style.paddingBlockStart) || 0) / fontSize),
      paddingBlockEndEm: round((parseFloat(style.paddingBlockEnd) || 0) / fontSize),
      dynamicPaddingStart: viewport.style.getPropertyValue(
        '--hc-math-scroll-padding-block-start',
      ).trim(),
      dynamicPaddingEnd: viewport.style.getPropertyValue(
        '--hc-math-scroll-padding-block-end',
      ).trim(),
      clientWidth: viewport.clientWidth,
      clientHeight: viewport.clientHeight,
      scrollWidth: viewport.scrollWidth,
      scrollHeight: viewport.scrollHeight,
      horizontallyOverflows: viewport.scrollWidth > viewport.clientWidth + 1,
      verticallyOverflows: viewport.scrollHeight > viewport.clientHeight + 1,
      rect: rectJSON(viewport.getBoundingClientRect()),
    };
  };
  const inspectShell = shell => {
    const style = getComputedStyle(shell);
    const directViewports = Array.from(shell.children).filter(
      child => child.classList.contains('hc-math-viewport'),
    );
    return {
      className: shell.className,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      hasScrollableClass: shell.classList.contains(
        'hc-math-viewport--scrollable',
      ),
      directViewportCount: directViewports.length,
      rect: rectJSON(shell.getBoundingClientRect()),
    };
  };
  const inspectCase = name => {
    const row = document.querySelector(`[data-probe-case="${name}"]`);
    const shells = Array.from(row.querySelectorAll('[data-math-shell]'));
    const viewports = shells.flatMap(shell =>
      Array.from(shell.children).filter(child =>
        child.classList.contains('hc-math-viewport')
      )
    );
    const fractions = viewports.flatMap(viewport =>
      Array.from(viewport.querySelectorAll('.mfrac'))
    ).map(inspectFraction);
    return {
      name,
      surface: row.dataset.surface,
      expectedFractionCount: Number(row.dataset.expectedFractions),
      expectsScroll: row.dataset.expectsScroll === 'true',
      shellCount: shells.length,
      viewportCount: viewports.length,
      shells: shells.map(inspectShell),
      viewports: viewports.map(inspectViewport),
      fractionCount: fractions.length,
      maximumFractionDepth: fractions.reduce(
        (maximum, fraction) => Math.max(maximum, fraction.depth),
        0,
      ),
      minimumPartVisibleRatio: round(
        fractions.reduce(
          (minimum, fraction) =>
            Math.min(minimum, fraction.minimumVisibleRatio),
          1,
        ),
      ),
      allFractionPartsVisible:
        fractions.length === Number(row.dataset.expectedFractions)
        && fractions.every(fraction => fraction.allPartsVisible),
      fractions,
    };
  };

  const editor = document.querySelector(
    '[data-probe-case="editable"] [data-testid="message-math-editor"]',
  );
  const renderedEditorFormulas = Array.from(
    editor?.querySelectorAll('[data-edit-math-state="rendered"]') ?? [],
  );
  const axisProbe = document.querySelector('[data-overflow-axis-probe]');
  const axisProbeStyle = getComputedStyle(axisProbe);
  const productionStyleSheets = Array.from(document.styleSheets)
    .map(sheet => sheet.href)
    .filter(href => href?.includes('/dist-assets/'));

  return JSON.stringify({
    userAgent: navigator.userAgent,
    fontsStatus: document.fonts.status,
    katexMainLoaded: document.fonts.check('1em KaTeX_Main'),
    axisRule: {
      specifiedOverflowX: 'auto',
      specifiedOverflowY: 'visible',
      computedOverflowX: axisProbeStyle.overflowX,
      computedOverflowY: axisProbeStyle.overflowY,
    },
    structuralSync: {
      state: document.documentElement.dataset.mathSync,
      initiallyScrollable: window.__hexNativeMathSync?.initiallyScrollable,
      viewportCount: window.__hexNativeMathSync?.viewportCount,
      firstScrollableCount: window.__hexNativeMathSync?.firstScrollableCount,
      secondScrollableCount: window.__hexNativeMathSync?.secondScrollableCount,
      scrollableClassOutsideViewportCount: document.querySelectorAll(
        '.hc-math-viewport--scrollable:not(.hc-math-viewport)'
      ).length,
      dynamicPaddingStyleCount: Array.from(
        document.querySelectorAll('[style]')
      ).filter(element =>
        element.getAttribute('style')?.includes('--hc-math-scroll-padding-block')
      ).length,
    },
    productionCss: {
      expectedStyleSheetCount: Number(
        document.documentElement.dataset.productionCssCount
      ),
      loadedStyleSheetCount: productionStyleSheets.length,
      loadedStyleSheets: productionStyleSheets,
      markdownScope: document.documentElement.dataset.markdownScope,
      messageTextScope: document.documentElement.dataset.messageTextScope,
      chatViewScope: document.documentElement.dataset.chatViewScope,
    },
    editableContract: {
      editorPresent: Boolean(editor),
      editorContentEditable: editor?.contentEditable,
      renderedFormulaCount: renderedEditorFormulas.length,
      allFormulasAtomic:
        renderedEditorFormulas.length === 2
        && renderedEditorFormulas.every(formula =>
          formula.contentEditable === 'false'
          && formula.dataset.editMathState === 'rendered'
          && formula.dataset.formulaMarkdown?.startsWith('$')
          && formula.dataset.formulaMarkdown?.endsWith('$')
        ),
    },
    ordinary: inspectCase('ordinary'),
    forcedOverflow: inspectCase('forced-overflow'),
    display: inspectCase('display'),
    editable: inspectCase('editable'),
  });
})()
"""#

private func fail(_ message: String, status: Int32 = 1) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  Foundation.exit(status)
}

private func object(_ value: Any?, _ key: String) -> [String: Any]? {
  (value as? [String: Any])?[key] as? [String: Any]
}

private func array(_ value: Any?, _ key: String) -> [[String: Any]] {
  (value as? [String: Any])?[key] as? [[String: Any]] ?? []
}

private func integer(_ value: Any?, _ key: String) -> Int {
  (value as? [String: Any])?[key] as? Int ?? -1
}

private func number(_ value: Any?, _ key: String) -> Double {
  (value as? [String: Any])?[key] as? Double ?? -1
}

private func boolean(_ value: Any?, _ key: String) -> Bool {
  (value as? [String: Any])?[key] as? Bool ?? false
}

private func string(_ value: Any?, _ key: String) -> String {
  (value as? [String: Any])?[key] as? String ?? ""
}

private func approximately(_ value: Double, _ expected: Double, tolerance: Double = 0.02) -> Bool {
  abs(value - expected) <= tolerance
}

private func genericCasePasses(_ mathCase: [String: Any]) -> Bool {
  let expectedFractions = integer(mathCase, "expectedFractionCount")
  let shells = array(mathCase, "shells")
  let viewports = array(mathCase, "viewports")
  return expectedFractions > 0
    && integer(mathCase, "fractionCount") == expectedFractions
    && integer(mathCase, "shellCount") == shells.count
    && integer(mathCase, "viewportCount") == viewports.count
    && !shells.isEmpty
    && shells.allSatisfy {
      string($0, "overflowX") == "visible"
        && string($0, "overflowY") == "visible"
        && !boolean($0, "hasScrollableClass")
        && integer($0, "directViewportCount") == 1
    }
    && viewports.allSatisfy {
      boolean($0, "isDirectChildOfShell")
        && string($0, "dynamicPaddingStart").isEmpty
        && string($0, "dynamicPaddingEnd").isEmpty
    }
    && boolean(mathCase, "allFractionPartsVisible")
    && number(mathCase, "minimumPartVisibleRatio") >= 0.999
}

private func nonScrollableCasePasses(_ mathCase: [String: Any]) -> Bool {
  let viewports = array(mathCase, "viewports")
  return genericCasePasses(mathCase)
    && !boolean(mathCase, "expectsScroll")
    && viewports.allSatisfy {
      !boolean($0, "classifiedAsNeedingScroll")
        && !boolean($0, "hasScrollableClass")
        && string($0, "overflowX") == "visible"
        && string($0, "overflowY") == "visible"
        && integer($0, "tabIndex") == -1
        && !boolean($0, "horizontallyOverflows")
        && approximately(number($0, "paddingBlockStartEm"), 0)
        && approximately(number($0, "paddingBlockEndEm"), 0)
    }
}

private func scrollableCasePasses(_ mathCase: [String: Any]) -> Bool {
  let viewports = array(mathCase, "viewports")
  return genericCasePasses(mathCase)
    && boolean(mathCase, "expectsScroll")
    && !viewports.isEmpty
    && viewports.allSatisfy {
      boolean($0, "classifiedAsNeedingScroll")
        && boolean($0, "hasScrollableClass")
        && string($0, "overflowX") == "auto"
        && string($0, "overflowY") == "hidden"
        && integer($0, "tabIndex") == 0
        && boolean($0, "horizontallyOverflows")
        && !boolean($0, "verticallyOverflows")
        && approximately(number($0, "paddingBlockStartEm"), 0.4)
        && approximately(number($0, "paddingBlockEndEm"), 0.4)
    }
}

private final class Probe: NSObject, WKNavigationDelegate {
  private let webView: WKWebView
  private let reportURL: URL
  private let screenshotURL: URL
  private var fontPollsRemaining = 100
  private var consecutiveLoadedFontPolls = 0
  private var mathSyncPollsRemaining = 100

  init(documentURL: URL, readAccessURL: URL, reportURL: URL, screenshotURL: URL) {
    self.reportURL = reportURL
    self.screenshotURL = screenshotURL

    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    webView = WKWebView(
      frame: NSRect(x: 0, y: 0, width: 1100, height: 1200),
      configuration: configuration
    )

    super.init()
    webView.navigationDelegate = self
    if documentURL.isFileURL {
      webView.loadFileURL(documentURL, allowingReadAccessTo: readAccessURL)
    } else {
      webView.load(URLRequest(url: documentURL))
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
    waitForFonts()
  }

  private func waitForFonts() {
    webView.evaluateJavaScript("document.fonts.status") { [weak self] value, error in
      guard let self else { return }
      if let error {
        fail("could not inspect WKWebView font status: \(error)")
      }
      if value as? String == "loaded" {
        self.consecutiveLoadedFontPolls += 1
        if self.consecutiveLoadedFontPolls >= 4 {
          self.startStructuralSync()
          return
        }
      } else {
        self.consecutiveLoadedFontPolls = 0
      }
      self.fontPollsRemaining -= 1
      if self.fontPollsRemaining <= 0 {
        fail("WKWebView did not finish loading the production KaTeX fonts")
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
        self.waitForFonts()
      }
    }
  }

  private func startStructuralSync() {
    let script = #"""
    (() => {
      if (typeof window.__runHexNativeStructuralSync !== "function") return false;
      void window.__runHexNativeStructuralSync();
      return true;
    })()
    """#
    webView.evaluateJavaScript(script) { [weak self] value, error in
      guard let self else { return }
      if let error {
        fail("could not start structural math sync: \(error)")
      }
      guard value as? Bool == true else {
        fail("native fixture did not expose its structural math sync")
      }
      self.waitForStructuralSync()
    }
  }

  private func waitForStructuralSync() {
    let script = #"""
    JSON.stringify({
      state: document.documentElement.dataset.mathSync || "pending",
      error: document.documentElement.dataset.mathSyncError || "",
    })
    """#
    webView.evaluateJavaScript(script) { [weak self] value, error in
      guard let self else { return }
      if let error {
        fail("could not inspect structural math sync state: \(error)")
      }
      if
        let json = value as? String,
        let data = json.data(using: .utf8),
        let state = try? JSONSerialization.jsonObject(with: data) as? [String: String]
      {
        if state["state"] == "complete" {
          self.measure()
          return
        }
        if state["state"] == "failed" {
          fail("structural math sync failed in WKWebView: \(state["error"] ?? "unknown error")")
        }
      }
      self.mathSyncPollsRemaining -= 1
      if self.mathSyncPollsRemaining <= 0 {
        fail(
          "structural math sync did not settle in WKWebView; "
            + "last state: \(String(describing: value))"
        )
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
        self.waitForStructuralSync()
      }
    }
  }

  private func measure() {
    webView.evaluateJavaScript(measurementScript) { [weak self] value, error in
      guard let self else { return }
      if let error {
        fail("WKWebView math measurement failed: \(error)")
      }
      guard
        let json = value as? String,
        let data = json.data(using: .utf8),
        let report = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let axisRule = report["axisRule"] as? [String: Any],
        let structuralSync = report["structuralSync"] as? [String: Any],
        let productionCss = report["productionCss"] as? [String: Any],
        let editableContract = report["editableContract"] as? [String: Any],
        let ordinary = report["ordinary"] as? [String: Any],
        let forcedOverflow = report["forcedOverflow"] as? [String: Any],
        let display = report["display"] as? [String: Any],
        let editable = report["editable"] as? [String: Any]
      else {
        fail("WKWebView returned an invalid math measurement: \(String(describing: value))")
      }

      let pretty = try! JSONSerialization.data(
        withJSONObject: report,
        options: [.prettyPrinted, .sortedKeys]
      )
      do {
        try FileManager.default.createDirectory(
          at: self.reportURL.deletingLastPathComponent(),
          withIntermediateDirectories: true
        )
        try pretty.write(to: self.reportURL, options: .atomic)
      } catch {
        fail("WKWebView measurement report could not be saved: \(error)")
      }

      let fontsLoaded = string(report, "fontsStatus") == "loaded"
        && boolean(report, "katexMainLoaded")
      let axisRulePasses = string(axisRule, "specifiedOverflowX") == "auto"
        && string(axisRule, "specifiedOverflowY") == "visible"
        && string(axisRule, "computedOverflowX") == "auto"
        && string(axisRule, "computedOverflowY") == "auto"
      let structuralSyncPasses = string(structuralSync, "state") == "complete"
        && integer(structuralSync, "initiallyScrollable") == 0
        && integer(structuralSync, "viewportCount") == 5
        && integer(structuralSync, "firstScrollableCount") == 2
        && integer(structuralSync, "secondScrollableCount") == 2
        && integer(structuralSync, "scrollableClassOutsideViewportCount") == 0
        && integer(structuralSync, "dynamicPaddingStyleCount") == 0
      let expectedStyleSheetCount = integer(productionCss, "expectedStyleSheetCount")
      let productionCssPasses = expectedStyleSheetCount > 1
        && integer(productionCss, "loadedStyleSheetCount") == expectedStyleSheetCount
        && !string(productionCss, "markdownScope").isEmpty
        && !string(productionCss, "messageTextScope").isEmpty
        && !string(productionCss, "chatViewScope").isEmpty
      let editableContractPasses = boolean(editableContract, "editorPresent")
        && string(editableContract, "editorContentEditable") == "true"
        && integer(editableContract, "renderedFormulaCount") == 2
        && boolean(editableContract, "allFormulasAtomic")
      let ordinaryPasses = integer(ordinary, "fractionCount") == 4
        && nonScrollableCasePasses(ordinary)
      let forcedOverflowPasses = integer(forcedOverflow, "fractionCount") == 16
        && scrollableCasePasses(forcedOverflow)
      let displayFractionCount = integer(display, "fractionCount")
      let displayPasses = displayFractionCount > 12
        && integer(display, "maximumFractionDepth") >= 3
        && scrollableCasePasses(display)
      let editablePasses = integer(editable, "fractionCount") == 2
        && nonScrollableCasePasses(editable)

      print(
        "WKWebView overflow axis rule: specified=auto visible "
          + "computed=\(string(axisRule, "computedOverflowX")) "
          + "\(string(axisRule, "computedOverflowY"))"
      )
      print(
        "WKWebView structural sync: viewports=\(integer(structuralSync, "viewportCount")) "
          + "scrollable=\(integer(structuralSync, "firstScrollableCount"))/"
          + "\(integer(structuralSync, "secondScrollableCount")) "
          + "outside-class=\(integer(structuralSync, "scrollableClassOutsideViewportCount")) "
          + "dynamic-padding=\(integer(structuralSync, "dynamicPaddingStyleCount"))"
      )
      print(
        "WKWebView production CSS: expected=\(expectedStyleSheetCount) "
          + "loaded=\(integer(productionCss, "loadedStyleSheetCount")) "
          + "chat=\(string(productionCss, "chatViewScope")) "
          + "message=\(string(productionCss, "messageTextScope")) "
          + "markdown=\(string(productionCss, "markdownScope"))"
      )
      for mathCase in [ordinary, forcedOverflow, display, editable] {
        let viewports = array(mathCase, "viewports")
        let viewportSummary = viewports.map {
          "\(string($0, "id")):"
            + "\(string($0, "overflowX"))/\(string($0, "overflowY"))"
            + ":pad=\(number($0, "paddingBlockStartEm"))em"
            + ":h=\(boolean($0, "horizontallyOverflows"))"
            + ":v=\(boolean($0, "verticallyOverflows"))"
        }.joined(separator: ",")
        print(
          "WKWebView \(string(mathCase, "name")) "
            + "fractions=\(integer(mathCase, "fractionCount")) "
            + "depth=\(integer(mathCase, "maximumFractionDepth")) "
            + "minimum-part-visible=\(number(mathCase, "minimumPartVisibleRatio")) "
            + "viewports=[\(viewportSummary)]"
        )
      }
      print("WKWebView measurement report: \(self.reportURL.path)")

      let snapshot = WKSnapshotConfiguration()
      snapshot.rect = self.webView.bounds
      self.webView.takeSnapshot(with: snapshot) { image, snapshotError in
        if let snapshotError {
          fail("WKWebView screenshot failed: \(snapshotError)")
        }
        guard
          let image,
          let tiff = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff),
          let png = bitmap.representation(using: .png, properties: [:])
        else {
          fail("WKWebView screenshot could not be encoded as PNG")
        }
        do {
          try FileManager.default.createDirectory(
            at: self.screenshotURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
          )
          try png.write(to: self.screenshotURL, options: .atomic)
        } catch {
          fail("WKWebView screenshot could not be saved: \(error)")
        }
        print("WKWebView screenshot: \(self.screenshotURL.path)")

        guard fontsLoaded else {
          fail("KaTeX fonts were not loaded, so the formula result is inconclusive")
        }
        guard axisRulePasses else {
          fail(
            "WKWebView did not apply the CSS overflow-axis computed-value rule "
              + "(auto + visible must compute to auto + auto)"
          )
        }
        guard structuralSyncPasses else {
          fail(
            "REGRESSION: scroll classification must target only the two horizontally "
              + "overflowing .hc-math-viewport elements and must not write dynamic ink padding"
          )
        }
        guard productionCssPasses else {
          fail(
            "native fixture did not load every production CSS chunk or resolve "
              + "the ChatView/MessageText/MarkdownRenderer scopes"
          )
        }
        guard ordinaryPasses else {
          fail(
            "REGRESSION: an ordinary formula in the real user-bubble structure "
              + "must keep its outer shell and inner viewport visibly overflowing"
          )
        }
        guard forcedOverflowPasses else {
          fail(
            "REGRESSION: only the inner viewport may scroll a long user formula; "
              + "its fixed 0.4em guard must preserve numerator, fraction line, and denominator"
          )
        }
        guard displayPasses else {
          fail(
            "REGRESSION: deeply nested Markdown display math lost structural scrolling "
              + "or vertically clipped a numerator, fraction line, or denominator"
          )
        }
        guard editableContractPasses && editablePasses else {
          fail(
            "REGRESSION: the edit-card projection must keep rendered formulas atomic, "
              + "editable as source on demand, and vertically unclipped"
          )
        }

        print("native WKWebView structural math visibility probe passed")
        Foundation.exit(0)
      }
    }
  }
}

let arguments = CommandLine.arguments
guard arguments.count == 5 else {
  fail(
    "Usage: WKWebViewMathVisibilityProbe "
      + "<fixture-url> <read-access-root> <report.json> <screenshot.png>",
    status: 2
  )
}

let documentURL: URL
if arguments[1].contains("://"), let remoteURL = URL(string: arguments[1]) {
  documentURL = remoteURL
} else {
  documentURL = URL(fileURLWithPath: arguments[1]).standardizedFileURL
}
let readAccessURL = URL(fileURLWithPath: arguments[2]).standardizedFileURL
let reportURL = URL(fileURLWithPath: arguments[3]).standardizedFileURL
let screenshotURL = URL(fileURLWithPath: arguments[4]).standardizedFileURL

guard !documentURL.isFileURL || FileManager.default.fileExists(atPath: documentURL.path) else {
  fail("fixture is missing: \(documentURL.path)", status: 2)
}

let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
private let probe = Probe(
  documentURL: documentURL,
  readAccessURL: readAccessURL,
  reportURL: reportURL,
  screenshotURL: screenshotURL
)
withExtendedLifetime(probe) {
  application.run()
}
