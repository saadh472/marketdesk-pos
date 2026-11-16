package com.saad.marketdesk;

import java.util.List;

public final class Models {
    private Models() { }
    public record Product(long id, String sku, String name, String category, long priceCents,
                          int stock, int reorderLevel, boolean active) { }
    public record ProductInput(String sku, String name, String category, Long priceCents,
                               Integer stock, Integer reorderLevel, Boolean active) { }
    public record StockInput(Integer delta, String reason) { }
    public record CartItem(Long productId, Integer quantity) { }
    public record CheckoutInput(String requestId, List<CartItem> items, Long tenderedCents) { }
    public record OrderItem(long productId, String name, int quantity, long unitPriceCents, long lineTotalCents) { }
    public record Order(long id, String createdAt, String status, long totalCents, long tenderedCents,
                        long changeCents, List<OrderItem> items) { }
    public record TopProduct(long productId, String name, long quantity, long salesCents) { }
    public record CategoryCount(String category, long count) { }
    public record Dashboard(long productCount, long stockUnits, long lowStockCount, long salesCents,
                            long orderCount, long pendingCount, List<Order> recentOrders,
                            List<TopProduct> topProducts, List<CategoryCount> categoryCounts) { }
}
