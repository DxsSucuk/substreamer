import ObjectiveC
import UIKit

/**
 * Pre-empts the iOS status-bar tap.
 *
 * React Native only surfaces the tap as `onScrollToTop`, which is emitted from
 * `scrollViewDidScrollToTop:` — a COMPLETION callback. By then UIKit has already animated
 * through the whole scroll view. For a windowed list holding several pages that traversal
 * flies past far more rows than the recycler can draw, which shows as blank gaps and
 * flashing. There is no way to shorten or suppress it after the fact.
 *
 * The decision point is `scrollViewShouldScrollToTop:`, which React Native implements as a
 * hard-coded `YES` with no prop behind it. Swizzling it lets JS answer instead: return
 * `false` and UIKit never starts the scroll, leaving the list free to reset itself
 * directly — instant, and identical to how an A-Z seek already behaves.
 *
 * `RCTScrollViewComponentView` is an RN internal reachable only by name, so this uses
 * `imp_implementationWithBlock` rather than a Swift extension: you cannot declare an
 * extension on a class the compiler does not know. Every lookup is guarded — if RN renames
 * the class or drops the delegate method, the swizzle is skipped and the app keeps stock
 * behaviour rather than crashing.
 */
final class ScrollToTopInterceptor {
  static let shared = ScrollToTopInterceptor()

  /// Read on the main thread by the delegate, written from JS. Needs the lock.
  private let lock = NSLock()
  private var armedValue = false

  private var installed = false

  var armed: Bool {
    get {
      lock.lock()
      defer { lock.unlock() }
      return armedValue
    }
    set {
      lock.lock()
      armedValue = newValue
      lock.unlock()
    }
  }

  /// Set by the module. Weakly captured there, so a dev reload cannot strand a dead module.
  var onTap: (() -> Void)?

  private init() {}

  /// True when the swizzle is in place, so JS can tell "declined" from "not available".
  var isSupported: Bool {
    lock.lock()
    defer { lock.unlock() }
    return installed
  }

  func install() {
    lock.lock()
    let alreadyInstalled = installed
    lock.unlock()
    guard !alreadyInstalled else { return }

    // RN internals, by name — see the class comment. Missing means an RN version that
    // moved them, in which case doing nothing is the correct outcome.
    guard let viewClass = NSClassFromString("RCTScrollViewComponentView") else { return }
    let selector = NSSelectorFromString("scrollViewShouldScrollToTop:")
    guard let method = class_getInstanceMethod(viewClass, selector) else { return }

    let original = method_getImplementation(method)
    typealias OriginalFn = @convention(c) (AnyObject, Selector, UIScrollView) -> Bool
    let callOriginal = unsafeBitCast(original, to: OriginalFn.self)

    let replacement: @convention(block) (AnyObject, UIScrollView) -> Bool = { receiver, scrollView in
      let interceptor = ScrollToTopInterceptor.shared
      guard interceptor.armed else {
        // Not ours: hand it back to RN untouched. Calling through matters beyond the
        // return value — the original also sets `_isUserTriggeredScrolling`, a private
        // ivar that gates RN's own content-offset preservation.
        return callOriginal(receiver, selector, scrollView)
      }
      // The delegate is already on the main thread; hop anyway so the emit never runs
      // inside UIKit's own call stack.
      DispatchQueue.main.async { interceptor.onTap?() }
      return false
    }

    method_setImplementation(method, imp_implementationWithBlock(replacement))

    lock.lock()
    installed = true
    lock.unlock()
  }
}
