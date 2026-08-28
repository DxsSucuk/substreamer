import ExpoModulesCore

public class ExpoScrollToTopModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoScrollToTop")

    Events("onStatusBarTap")

    OnCreate {
      // Weak, so the singleton cannot keep a dead module alive across a dev reload.
      ScrollToTopInterceptor.shared.onTap = { [weak self] in
        self?.sendEvent("onStatusBarTap", [:])
      }
      ScrollToTopInterceptor.shared.install()
    }

    OnDestroy {
      ScrollToTopInterceptor.shared.armed = false
      ScrollToTopInterceptor.shared.onTap = nil
    }

    // Armed only while a list that wants to handle the tap itself is on screen. While
    // disarmed every scroll view keeps stock behaviour, so this cannot leak into screens
    // that never asked for it.
    Function("setArmed") { (armed: Bool) in
      ScrollToTopInterceptor.shared.armed = armed
    }

    Function("isSupported") {
      ScrollToTopInterceptor.shared.isSupported
    }
  }
}
