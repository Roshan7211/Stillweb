import ExpoModulesCore
import StoreKit
import UIKit

/// Stillweb Plus purchases with StoreKit 2: products, purchase, restore and what is unlocked.
/// Transactions are verified on device by StoreKit (JWS); unverified ones never unlock.
public class PlusStoreModule: Module {
  private var updates: Task<Void, Never>?

  public func definition() -> ModuleDefinition {
    Name("PlusStore")

    Events("onEntitlementsChanged")

    OnCreate {
      // Purchases that complete outside the app's purchase flow: renewals, Ask to Buy
      // approvals, refunds, offer codes redeemed in the App Store.
      self.updates = Task.detached { [weak self] in
        for await update in Transaction.updates {
          if case .verified(let transaction) = update {
            await transaction.finish()
          }
          await self?.notifyEntitlements()
        }
      }
    }

    OnDestroy {
      self.updates?.cancel()
    }

    AsyncFunction("getProducts") { (ids: [String], promise: Promise) in
      Task { () async -> Void in
        do {
          let products = try await Product.products(for: ids)
          var described: [[String: Any]] = []
          for product in products {
            described.append(await Self.describe(product))
          }
          promise.resolve(described)
        } catch {
          promise.reject("E_PRODUCTS", error.localizedDescription)
        }
      }
    }

    AsyncFunction("purchase") { (id: String, promise: Promise) in
      Task { @MainActor () async -> Void in
        do {
          guard let product = try await Product.products(for: [id]).first else {
            return promise.reject("E_PRODUCT", "This plan isn't available right now.")
          }
          let result = try await Self.buy(product)
          switch result {
          case .success(let verification):
            guard case .verified(let transaction) = verification else {
              return promise.reject("E_UNVERIFIED", "The App Store couldn't verify this purchase.")
            }
            await transaction.finish()
            promise.resolve(await Self.outcome("purchased"))
          case .pending:
            // Ask to Buy or a payment that needs action: Transaction.updates reports it later.
            promise.resolve(await Self.outcome("pending"))
          case .userCancelled:
            promise.resolve(await Self.outcome("cancelled"))
          @unknown default:
            promise.resolve(await Self.outcome("cancelled"))
          }
        } catch {
          promise.reject("E_PURCHASE", error.localizedDescription)
        }
      }
    }

    AsyncFunction("getEntitlements") { (promise: Promise) in
      Task { () async -> Void in
        promise.resolve(await Self.entitlements())
      }
    }

    // "Restore Purchases": syncs with the App Store (may ask the user to sign in).
    AsyncFunction("restore") { (promise: Promise) in
      Task { () async -> Void in
        do {
          try await AppStore.sync()
          promise.resolve(await Self.entitlements())
        } catch {
          promise.reject("E_RESTORE", error.localizedDescription)
        }
      }
    }

    AsyncFunction("showManageSubscriptions") { (promise: Promise) in
      Task { @MainActor () async -> Void in
        if let scene = Self.windowScene() {
          do {
            try await AppStore.showManageSubscriptions(in: scene)
            return promise.resolve(true)
          } catch {}
        }
        // The App Store's subscriptions page as a fallback.
        if let url = URL(string: "https://apps.apple.com/account/subscriptions") {
          await UIApplication.shared.open(url)
        }
        promise.resolve(true)
      }
    }

    AsyncFunction("presentOfferCodeRedeemSheet") { (promise: Promise) in
      Task { @MainActor () async -> Void in
        guard let scene = Self.windowScene() else { return promise.resolve(false) }
        do {
          try await AppStore.presentOfferCodeRedeemSheet(in: scene)
          promise.resolve(true)
        } catch {
          promise.reject("E_REDEEM", error.localizedDescription)
        }
      }
    }
  }

  private func notifyEntitlements() async {
    let current = await Self.entitlements()
    await MainActor.run {
      self.sendEvent("onEntitlementsChanged", ["entitlements": current])
    }
  }

  private static func outcome(_ status: String) async -> [String: Any] {
    ["status": status, "entitlements": await entitlements()]
  }

  @MainActor
  private static func buy(_ product: Product) async throws -> Product.PurchaseResult {
    #if compiler(>=5.9)
      // iOS 18.2+ requires a window to show the confirmation in (UIKit apps fail without).
      if #available(iOS 17.0, *), let scene = windowScene() {
        return try await product.purchase(confirmIn: scene)
      }
    #endif
    return try await product.purchase()
  }

  @MainActor
  private static func windowScene() -> UIWindowScene? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    return scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
  }

  /// Active, verified purchases made with this Apple Account: the current subscription and the
  /// lifetime unlock. Plus isn't shared with family members, so shared transactions don't count.
  private static func entitlements() async -> [[String: Any]] {
    var active: [[String: Any]] = []
    for await result in Transaction.currentEntitlements {
      guard case .verified(let transaction) = result, transaction.revocationDate == nil,
            transaction.ownershipType == .purchased else { continue }
      if let expires = transaction.expirationDate, expires < Date() { continue }
      var entry: [String: Any] = [
        "productId": transaction.productID,
        "purchasedAt": transaction.purchaseDate.timeIntervalSince1970 * 1000,
      ]
      if let expires = transaction.expirationDate {
        entry["expiresAt"] = expires.timeIntervalSince1970 * 1000
      }
      active.append(entry)
    }
    return active
  }

  private static func describe(_ product: Product) async -> [String: Any] {
    var info: [String: Any] = [
      "id": product.id,
      "displayName": product.displayName,
      "description": product.description,
      "displayPrice": product.displayPrice,
      "price": NSDecimalNumber(decimal: product.price).doubleValue,
      "currencyCode": product.priceFormatStyle.currencyCode,
      "type": product.type == .autoRenewable ? "subscription" : "lifetime",
    ]
    if let subscription = product.subscription {
      info["period"] = period(subscription.subscriptionPeriod)
      info["introEligible"] = await subscription.isEligibleForIntroOffer
      if let offer = subscription.introductoryOffer {
        info["introOffer"] = [
          "paymentMode": paymentMode(offer.paymentMode),
          "period": period(offer.period),
          "periodCount": offer.periodCount,
          "displayPrice": offer.displayPrice,
        ] as [String: Any]
      }
    }
    return info
  }

  private static func period(_ period: Product.SubscriptionPeriod) -> [String: Any] {
    let unit: String
    switch period.unit {
    case .day: unit = "day"
    case .week: unit = "week"
    case .month: unit = "month"
    case .year: unit = "year"
    @unknown default: unit = "month"
    }
    return ["unit": unit, "value": period.value]
  }

  private static func paymentMode(_ mode: Product.SubscriptionOffer.PaymentMode) -> String {
    switch mode {
    case .freeTrial: return "freeTrial"
    case .payAsYouGo: return "payAsYouGo"
    case .payUpFront: return "payUpFront"
    default: return "other"
    }
  }
}
