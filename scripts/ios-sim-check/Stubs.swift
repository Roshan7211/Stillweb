import UIKit

public class AppContext {}
open class ExpoView: UIView {
  public required init(appContext: AppContext? = nil) { super.init(frame: .zero) }
  @available(*, unavailable) public required init?(coder: NSCoder) { fatalError() }
}
/// Stand-in for Expo's event dispatcher: the test hooks the events it wants to see.
public final class EventDispatcher {
  public var handler: (([String: Any?]) -> Void)?
  public init() {}
  public func callAsFunction(_ body: [String: Any?] = [:]) { handler?(body) }
}
