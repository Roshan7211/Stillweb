package expo.modules.shieldwebview

import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClient.BillingResponseCode
import com.android.billingclient.api.BillingClient.ProductType
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Stillweb Plus purchases with Google Play Billing: products, purchase, restore and what is
 * unlocked. The same shape as the iOS module (PlusStoreModule.swift), so the Plus screen is
 * shared. Product ids are the App Store's: the two plans are subscriptions (one base plan
 * each; the yearly one may carry a free-trial offer) and the lifetime unlock is a one-time
 * product that is never consumed.
 */
class PlusStoreModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private var client: BillingClient? = null
  private var connecting = mutableListOf<(BillingClient?) -> Unit>()
  /** The purchase sheet that is open: resolved by the purchases listener. */
  private var pendingPurchase: Promise? = null

  /** Purchases made in the app's sheet, and ones that arrive later (pending payments). */
  private val purchasesListener = PurchasesUpdatedListener { result, purchases ->
    val promise = pendingPurchase
    pendingPurchase = null
    when (result.responseCode) {
      BillingResponseCode.OK -> {
        purchases.orEmpty().forEach(::acknowledge)
        val pending = purchases.orEmpty().any { it.purchaseState == Purchase.PurchaseState.PENDING }
        // Straight from the purchase when asking Google Play again fails.
        val bought = purchases.orEmpty().filter { it.purchaseState == Purchase.PurchaseState.PURCHASED }
          .flatMap { p -> p.products.map { mapOf<String, Any>("productId" to it, "purchasedAt" to p.purchaseTime.toDouble()) } }
        entitlements { current ->
          val now = current ?: bought
          promise?.resolve(mapOf("status" to if (pending) "pending" else "purchased", "entitlements" to now))
          sendEvent("onEntitlementsChanged", mapOf("entitlements" to now))
        }
      }
      BillingResponseCode.USER_CANCELED ->
        entitlements { current -> promise?.resolve(mapOf("status" to "cancelled", "entitlements" to current.orEmpty())) }
      BillingResponseCode.ITEM_ALREADY_OWNED ->
        entitlements { current ->
          if (current == null) return@entitlements promise?.reject("E_PURCHASE", "Google Play couldn't be reached.", null) ?: Unit
          promise?.resolve(mapOf("status" to "purchased", "entitlements" to current))
          sendEvent("onEntitlementsChanged", mapOf("entitlements" to current))
        }
      else -> promise?.reject("E_PURCHASE", message(result), null)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("PlusStore")

    Events("onEntitlementsChanged")

    OnDestroy {
      client?.endConnection()
      client = null
    }

    // Back in the app: a payment that was pending, or a subscription changed in Google Play.
    OnActivityEntersForeground {
      if (client != null) entitlements { current -> if (current != null) sendEvent("onEntitlementsChanged", mapOf("entitlements" to current)) }
    }

    AsyncFunction("getProducts") { ids: List<String>, promise: Promise ->
      products(ids) { details, error ->
        if (details == null) promise.reject("E_PRODUCTS", error ?: "Google Play couldn't be reached.", null)
        else promise.resolve(ids.mapNotNull { id -> details.firstOrNull { it.productId == id } }.map(::describe))
      }
    }

    AsyncFunction("purchase") { id: String, promise: Promise ->
      val activity = appContext.currentActivity
        ?: return@AsyncFunction promise.reject("E_PURCHASE", "The app isn't on screen.", null)
      products(listOf(id)) { details, error ->
        val product = details?.firstOrNull { it.productId == id }
          ?: return@products promise.reject("E_PRODUCT", error ?: "This plan isn't available right now.", null)
        owned { known ->
          val purchases = known.orEmpty()
          val params = BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(product)
          if (product.productType == ProductType.SUBS) {
            val offer = chosenOffer(product)
              ?: return@owned promise.reject("E_PRODUCT", "This plan isn't available right now.", null)
            params.setOfferToken(offer.offerToken)
          } else {
            product.oneTimePurchaseOfferDetailsList?.firstOrNull()?.offerToken?.let(params::setOfferToken)
          }
          val flow = BillingFlowParams.newBuilder().setProductDetailsParamsList(listOf(params.build()))
          // Monthly to yearly (or back): Google Play replaces the plan instead of adding one.
          val current = purchases.firstOrNull { purchase ->
            purchase.purchaseState == Purchase.PurchaseState.PURCHASED && purchase.isAutoRenewing &&
              purchase.products.none { it == id } && purchase.products.any { it in SUBSCRIPTIONS }
          }
          if (product.productType == ProductType.SUBS && current != null) {
            flow.setSubscriptionUpdateParams(
              BillingFlowParams.SubscriptionUpdateParams.newBuilder().setOldPurchaseToken(current.purchaseToken).build()
            )
          }
          main.post {
            val billing = client ?: return@post promise.reject("E_PURCHASE", "Google Play couldn't be reached.", null)
            pendingPurchase?.resolve(mapOf("status" to "cancelled", "entitlements" to emptyList<Any>()))
            pendingPurchase = promise
            val launched = billing.launchBillingFlow(activity, flow.build())
            if (launched.responseCode != BillingResponseCode.OK) {
              pendingPurchase = null
              promise.reject("E_PURCHASE", message(launched), null)
            }
          }
        }
      }
    }

    AsyncFunction("getEntitlements") { promise: Promise ->
      entitlements { current ->
        if (current == null) promise.reject("E_STORE", "Google Play couldn't be reached.", null) else promise.resolve(current)
      }
    }

    // "Restore purchases": Google Play keeps them with the Google Account, so asking again is all.
    AsyncFunction("restore") { promise: Promise ->
      connect { billing ->
        if (billing == null) promise.reject("E_RESTORE", "Google Play couldn't be reached. Check your connection.", null)
        else entitlements { current ->
          if (current == null) promise.reject("E_RESTORE", "Google Play couldn't be reached. Check your connection.", null)
          else promise.resolve(current)
        }
      }
    }

    AsyncFunction("showManageSubscriptions") { promise: Promise ->
      val context = appContext.reactContext
      promise.resolve(open("https://play.google.com/store/account/subscriptions?package=${context?.packageName.orEmpty()}"))
    }

    AsyncFunction("presentOfferCodeRedeemSheet") { promise: Promise ->
      promise.resolve(open("https://play.google.com/redeem"))
    }
  }

  // ---------------------------------------------------------------------------
  // Google Play

  private fun open(url: String): Boolean = runCatching {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    (appContext.currentActivity ?: appContext.reactContext)?.startActivity(intent)
    true
  }.getOrDefault(false)

  /** Runs `then` with a connected client, or null when Google Play can't be reached. */
  private fun connect(then: (BillingClient?) -> Unit) {
    main.post {
      val existing = client
      if (existing != null && existing.isReady) return@post then(existing)
      connecting.add(then)
      if (connecting.size > 1) return@post
      val context = appContext.reactContext?.applicationContext ?: return@post finishConnecting(null)
      val billing = existing ?: BillingClient.newBuilder(context)
        .setListener(purchasesListener)
        .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
        .enableAutoServiceReconnection()
        .build()
        .also { client = it }
      billing.startConnection(object : BillingClientStateListener {
        override fun onBillingSetupFinished(result: BillingResult) {
          main.post { finishConnecting(if (result.responseCode == BillingResponseCode.OK) billing else null) }
        }

        override fun onBillingServiceDisconnected() {
          // The library reconnects by itself (enableAutoServiceReconnection).
        }
      })
    }
  }

  private fun finishConnecting(billing: BillingClient?) {
    val waiting = connecting
    connecting = mutableListOf()
    waiting.forEach { it(billing) }
  }

  /** Details of the given products (subscriptions and one-time), or null with a message. */
  private fun products(ids: List<String>, then: (List<ProductDetails>?, String?) -> Unit) {
    connect { billing ->
      if (billing == null) return@connect then(null, "Google Play couldn't be reached. Check your connection.")
      val groups = listOf(
        ProductType.SUBS to ids.filter { it in SUBSCRIPTIONS },
        ProductType.INAPP to ids.filter { it !in SUBSCRIPTIONS },
      ).filter { it.second.isNotEmpty() }
      if (groups.isEmpty()) return@connect then(emptyList(), null)
      val found = mutableListOf<ProductDetails>()
      var left = groups.size
      var failure: String? = null
      for ((type, group) in groups) {
        val params = QueryProductDetailsParams.newBuilder().setProductList(
          group.map { QueryProductDetailsParams.Product.newBuilder().setProductId(it).setProductType(type).build() }
        ).build()
        billing.queryProductDetailsAsync(params) { result, details ->
          main.post {
            if (result.responseCode == BillingResponseCode.OK) found.addAll(details.productDetailsList)
            else failure = message(result)
            if (--left == 0) then(if (failure != null && found.isEmpty()) null else found, failure)
          }
        }
      }
    }
  }

  /**
   * Every purchase Google Play has for this account, of both kinds; null when Google Play
   * can't say (the app then keeps what it last knew instead of locking Plus).
   */
  private fun owned(then: (List<Purchase>?) -> Unit) {
    connect { billing ->
      if (billing == null) return@connect then(null)
      val all = mutableListOf<Purchase>()
      var left = 2
      var failed = false
      for (type in listOf(ProductType.SUBS, ProductType.INAPP)) {
        billing.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(type).build()) { result, purchases ->
          main.post {
            if (result.responseCode == BillingResponseCode.OK) all.addAll(purchases) else failed = true
            if (--left == 0) then(if (failed) null else all)
          }
        }
      }
    }
  }

  /**
   * Paid purchases: the current subscription and the lifetime unlock. Google Play lists a
   * subscription only while it gives access (also in its grace period); pending payments and
   * suspended subscriptions don't unlock.
   */
  private fun entitlements(then: (List<Map<String, Any>>?) -> Unit) {
    owned { purchases ->
      if (purchases == null) return@owned then(null)
      val active = purchases.filter { it.purchaseState == Purchase.PurchaseState.PURCHASED && !it.isSuspended }
      active.forEach(::acknowledge)
      then(active.flatMap { purchase ->
        purchase.products.map { mapOf("productId" to it, "purchasedAt" to purchase.purchaseTime.toDouble()) }
      })
    }
  }

  /** Google Play refunds a purchase that isn't acknowledged within three days. */
  private fun acknowledge(purchase: Purchase) {
    if (purchase.purchaseState != Purchase.PurchaseState.PURCHASED || purchase.isAcknowledged) return
    client?.acknowledgePurchase(AcknowledgePurchaseParams.newBuilder().setPurchaseToken(purchase.purchaseToken).build()) { }
  }

  private fun message(result: BillingResult): String = when (result.responseCode) {
    BillingResponseCode.BILLING_UNAVAILABLE -> "Purchases aren't available on this device. Check that you're signed in to Google Play."
    BillingResponseCode.SERVICE_UNAVAILABLE, BillingResponseCode.SERVICE_DISCONNECTED, BillingResponseCode.NETWORK_ERROR ->
      "Google Play couldn't be reached. Check your connection."
    BillingResponseCode.ITEM_UNAVAILABLE -> "This plan isn't available right now."
    else -> "Google Play couldn't complete this (code ${result.responseCode})."
  }

  // ---------------------------------------------------------------------------
  // Describing products

  /**
   * The offer a buyer gets: the free trial when Google Play offers it to this account (it only
   * lists offers the account is eligible for), otherwise the plan itself.
   */
  private fun chosenOffer(product: ProductDetails): ProductDetails.SubscriptionOfferDetails? {
    val offers = product.subscriptionOfferDetails.orEmpty()
    return offers.firstOrNull { trialPhase(it) != null } ?: offers.firstOrNull { it.offerId == null } ?: offers.firstOrNull()
  }

  private fun trialPhase(offer: ProductDetails.SubscriptionOfferDetails): ProductDetails.PricingPhase? =
    offer.pricingPhases.pricingPhaseList.firstOrNull()?.takeIf { it.priceAmountMicros == 0L && offer.pricingPhases.pricingPhaseList.size > 1 }

  private fun describe(product: ProductDetails): Map<String, Any> {
    val info = mutableMapOf<String, Any>(
      "id" to product.productId,
      "displayName" to product.name,
      "description" to product.description,
    )
    if (product.productType == ProductType.SUBS) {
      val offer = chosenOffer(product)
      // What it costs once any trial is over: the last phase.
      val price = offer?.pricingPhases?.pricingPhaseList?.lastOrNull()
      info["type"] = "subscription"
      info["displayPrice"] = price?.formattedPrice.orEmpty()
      info["price"] = (price?.priceAmountMicros ?: 0L) / 1_000_000.0
      info["currencyCode"] = price?.priceCurrencyCode.orEmpty()
      price?.billingPeriod?.let(::period)?.let { info["period"] = it }
      val trial = offer?.let(::trialPhase)
      info["introEligible"] = trial != null
      if (trial != null) {
        info["introOffer"] = mapOf(
          "paymentMode" to "freeTrial",
          "period" to (period(trial.billingPeriod) ?: mapOf("unit" to "day", "value" to 14)),
          "periodCount" to trial.billingCycleCount.coerceAtLeast(1),
          "displayPrice" to trial.formattedPrice,
        )
      }
    } else {
      val price = product.oneTimePurchaseOfferDetails
      info["type"] = "lifetime"
      info["displayPrice"] = price?.formattedPrice.orEmpty()
      info["price"] = (price?.priceAmountMicros ?: 0L) / 1_000_000.0
      info["currencyCode"] = price?.priceCurrencyCode.orEmpty()
    }
    return info
  }

  /** ISO 8601 periods as Google Play writes them: P1Y, P1M, P2W, P14D. */
  private fun period(iso: String): Map<String, Any>? {
    val match = Regex("^P(\\d+)([DWMY])$").find(iso) ?: return null
    val unit = when (match.groupValues[2]) {
      "D" -> "day"
      "W" -> "week"
      "M" -> "month"
      else -> "year"
    }
    return mapOf("unit" to unit, "value" to match.groupValues[1].toInt())
  }

  private companion object {
    /** The subscription plans; any other product id is a one-time product. */
    val SUBSCRIPTIONS = setOf("app.stillweb.browser.plus.yearly", "app.stillweb.browser.plus.monthly")
  }
}
