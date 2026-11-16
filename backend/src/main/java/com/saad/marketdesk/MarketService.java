package com.saad.marketdesk;

import static com.saad.marketdesk.Models.*;
import jakarta.annotation.PostConstruct;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

@Service
public class MarketService {
    private static final long MAX_MONEY = 100_000_000_000L;
    private static final int MAX_STOCK = 1_000_000;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final RowMapper<Product> productMapper = (row, index) -> new Product(row.getLong("id"), row.getString("sku"),
        row.getString("name"), row.getString("category"), row.getLong("price_cents"), row.getInt("stock"),
        row.getInt("reorder_level"), row.getInt("active") == 1);
    public MarketService(JdbcTemplate jdbc, PlatformTransactionManager manager) {
        this.jdbc = jdbc; this.transaction = new TransactionTemplate(manager);
    }
    @PostConstruct
    void initialize() {
        transaction.executeWithoutResult(status -> {
            jdbc.execute("CREATE TABLE IF NOT EXISTS schema_metadata (version INTEGER PRIMARY KEY)");
            jdbc.execute("CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL COLLATE NOCASE UNIQUE, name TEXT NOT NULL, category TEXT NOT NULL, price_cents INTEGER NOT NULL CHECK(price_cents>0), stock INTEGER NOT NULL CHECK(stock>=0), reorder_level INTEGER NOT NULL CHECK(reorder_level>=0), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)))");
            jdbc.execute("CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('PENDING','FULFILLED','CANCELLED')), total_cents INTEGER NOT NULL, tendered_cents INTEGER NOT NULL, change_cents INTEGER NOT NULL)");
            jdbc.execute("CREATE TABLE IF NOT EXISTS order_items (order_id INTEGER NOT NULL REFERENCES orders(id), position INTEGER NOT NULL, product_id INTEGER NOT NULL REFERENCES products(id), name TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity>0), unit_price_cents INTEGER NOT NULL, line_total_cents INTEGER NOT NULL, PRIMARY KEY(order_id,position))");
            jdbc.execute("CREATE TABLE IF NOT EXISTS stock_movements (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id), delta INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL)");
            jdbc.execute("CREATE INDEX IF NOT EXISTS order_status_id ON orders(status,id)");
            if (jdbc.queryForObject("SELECT COUNT(*) FROM schema_metadata WHERE version=1", Long.class) == 0) {
                Object[][] samples = {
                    {"GR-001", "Basmati Rice 1 kg", "Grocery", 38500L, 42, 10},
                    {"GR-002", "Whole Wheat Flour 1 kg", "Grocery", 16500L, 36, 10},
                    {"DA-001", "Fresh Milk 1 L", "Dairy", 29500L, 28, 8},
                    {"DA-002", "Plain Yogurt 500 g", "Dairy", 21000L, 6, 8},
                    {"BE-001", "Orange Juice 1 L", "Beverages", 33000L, 20, 5},
                    {"SN-001", "Oat Biscuits", "Snacks", 12500L, 34, 10},
                    {"HO-001", "Dishwashing Liquid", "Household", 24500L, 4, 6},
                    {"PR-001", "Apples 1 kg", "Produce", 42000L, 18, 5}
                };
                for (Object[] sample : samples) jdbc.update("INSERT INTO products(sku,name,category,price_cents,stock,reorder_level) VALUES (?,?,?,?,?,?)", sample);
                jdbc.update("INSERT INTO schema_metadata(version) VALUES (1)");
            }
        });
    }
    public List<Product> products() { return new ArrayList<>(jdbc.query("SELECT * FROM products ORDER BY name COLLATE NOCASE,id", productMapper)); }
    private Product product(long id) {
        return jdbc.query("SELECT * FROM products WHERE id=?", productMapper, id).stream().findFirst()
            .orElseThrow(() -> error(HttpStatus.NOT_FOUND, "Product not found."));
    }
    public synchronized Product add(ProductInput input) {
        validateProduct(input);
        return transaction.execute(status -> {
            ensureUniqueSku(input.sku().trim(), 0);
            jdbc.update("INSERT INTO products(sku,name,category,price_cents,stock,reorder_level,active) VALUES (?,?,?,?,?,?,?)",
                input.sku().trim().toUpperCase(Locale.ROOT), input.name().trim(), input.category().trim(), input.priceCents(),
                input.stock(), input.reorderLevel(), input.active() == null || input.active() ? 1 : 0);
            long id = jdbc.queryForObject("SELECT last_insert_rowid()", Long.class);
            return product(id);
        });
    }
    public synchronized Product update(long id, ProductInput input) {
        validateProduct(input);
        return transaction.execute(status -> {
            Product old = product(id);
            if (old.stock() != input.stock()) throw error(HttpStatus.CONFLICT, "Adjust stock using a stock movement so the change has a reason.");
            ensureUniqueSku(input.sku().trim(), id);
            jdbc.update("UPDATE products SET sku=?,name=?,category=?,price_cents=?,reorder_level=?,active=? WHERE id=?",
                input.sku().trim().toUpperCase(Locale.ROOT), input.name().trim(), input.category().trim(), input.priceCents(),
                input.reorderLevel(), input.active() == null || input.active() ? 1 : 0, id);
            return product(id);
        });
    }
    public synchronized Product adjustStock(long id, StockInput input) {
        if (input.delta() == null || input.delta() == 0 || Math.abs((long) input.delta()) > MAX_STOCK) throw error(HttpStatus.BAD_REQUEST, "Enter a non-zero stock adjustment up to 1,000,000 units.");
        String reason = requiredText(input.reason(), "Stock adjustment reason", 200);
        return transaction.execute(status -> {
            product(id);
            int changed = jdbc.update("UPDATE products SET stock=stock+? WHERE id=? AND stock+? BETWEEN 0 AND ?", input.delta(), id, input.delta(), MAX_STOCK);
            if (changed != 1) throw error(HttpStatus.CONFLICT, "Stock cannot fall below zero or exceed 1,000,000 units.");
            recordStock(id, input.delta(), reason);
            return product(id);
        });
    }
    public synchronized Order checkout(CheckoutInput input) {
        String requestId;
        try {
            requestId = UUID.fromString(input.requestId()).toString();
            if (!requestId.equalsIgnoreCase(input.requestId())) throw new IllegalArgumentException();
        }
        catch (Exception exception) { throw error(HttpStatus.BAD_REQUEST, "A UUID requestId is required for safe checkout retries."); }
        if (input.items() == null || input.items().isEmpty() || input.items().size() > 100) throw error(HttpStatus.BAD_REQUEST, "A cart must contain 1 to 100 different products.");
        if (input.tenderedCents() == null || input.tenderedCents() < 0 || input.tenderedCents() > MAX_MONEY) throw error(HttpStatus.BAD_REQUEST, "Enter a valid cash amount in integer paisa.");
        // HashMap gives O(1) duplicate detection; a canonical sorted ArrayList makes retry matching independent of cart order.
        Map<Long, Integer> quantities = new HashMap<>();
        for (CartItem item : input.items()) {
            if (item == null || item.productId() == null || item.productId() < 1 || item.quantity() == null || item.quantity() < 1 || item.quantity() > 1000) throw error(HttpStatus.BAD_REQUEST, "Each item needs a product ID and a whole quantity between 1 and 1,000.");
            if (quantities.putIfAbsent(item.productId(), item.quantity()) != null) throw error(HttpStatus.BAD_REQUEST, "Each product may appear only once in a checkout.");
        }
        List<Long> ids = new ArrayList<>(quantities.keySet());
        Collections.sort(ids);
        StringBuilder canonical = new StringBuilder().append(input.tenderedCents());
        for (long id : ids) canonical.append('|').append(id).append(':').append(quantities.get(id));
        String hash = digest(canonical.toString());
        final String key = requestId;
        return transaction.execute(status -> {
            List<Map<String, Object>> previous = jdbc.queryForList("SELECT id,payload_hash FROM orders WHERE request_id=?", key);
            if (!previous.isEmpty()) {
                if (!hash.equals(previous.get(0).get("payload_hash"))) throw error(HttpStatus.CONFLICT, "This checkout request ID was already used for a different cart.");
                return order(((Number) previous.get(0).get("id")).longValue());
            }
            List<OrderItem> lines = new ArrayList<>();
            long total = 0;
            for (long id : ids) {
                Product selected = product(id);
                int quantity = quantities.get(id);
                if (!selected.active()) throw error(HttpStatus.CONFLICT, selected.name() + " is archived and cannot be sold.");
                long lineTotal = Math.multiplyExact(selected.priceCents(), quantity);
                total = Math.addExact(total, lineTotal);
                if (total > MAX_MONEY) throw error(HttpStatus.BAD_REQUEST, "The cart total exceeds the supported cash limit.");
                if (jdbc.update("UPDATE products SET stock=stock-? WHERE id=? AND stock>=? AND active=1", quantity, id, quantity) != 1) throw error(HttpStatus.CONFLICT, "Not enough stock for " + selected.name() + ". Refresh your cart.");
                lines.add(new OrderItem(id, selected.name(), quantity, selected.priceCents(), lineTotal));
            }
            if (input.tenderedCents() < total) throw error(HttpStatus.BAD_REQUEST, "Cash received must cover the cart total.");
            jdbc.update("INSERT INTO orders(request_id,payload_hash,created_at,status,total_cents,tendered_cents,change_cents) VALUES (?,?,?,'PENDING',?,?,?)", key, hash, Instant.now().toString(), total, input.tenderedCents(), input.tenderedCents()-total);
            long orderId = jdbc.queryForObject("SELECT last_insert_rowid()", Long.class);
            for (int index=0; index<lines.size(); index++) {
                OrderItem line = lines.get(index);
                jdbc.update("INSERT INTO order_items(order_id,position,product_id,name,quantity,unit_price_cents,line_total_cents) VALUES (?,?,?,?,?,?,?)", orderId, index, line.productId(), line.name(), line.quantity(), line.unitPriceCents(), line.lineTotalCents());
                recordStock(line.productId(), -line.quantity(), "Checkout #" + orderId);
            }
            return order(orderId);
        });
    }
    public List<Order> orders() {
        return jdbc.query("SELECT id FROM orders ORDER BY id DESC", (row,index) -> row.getLong(1)).stream().map(this::order).toList();
    }
    private Order order(long id) {
        List<OrderItem> lines = jdbc.query("SELECT * FROM order_items WHERE order_id=? ORDER BY position", (row,index) -> new OrderItem(row.getLong("product_id"), row.getString("name"), row.getInt("quantity"), row.getLong("unit_price_cents"), row.getLong("line_total_cents")), id);
        return jdbc.queryForObject("SELECT * FROM orders WHERE id=?", (row,index) -> new Order(row.getLong("id"), row.getString("created_at"), row.getString("status"), row.getLong("total_cents"), row.getLong("tendered_cents"), row.getLong("change_cents"), lines), id);
    }
    public synchronized Order fulfillNext() { return changePending(false); }
    public synchronized Order cancelLast() { return changePending(true); }
    private Order changePending(boolean cancel) {
        return transaction.execute(status -> {
            // Rebuild from durable order IDs on every operation: restart-safe FIFO queue and LIFO stack.
            ArrayDeque<Long> pending = new ArrayDeque<>(jdbc.query("SELECT id FROM orders WHERE status='PENDING' ORDER BY id", (row,index) -> row.getLong(1)));
            Long id = cancel ? pending.pollLast() : pending.pollFirst();
            if (id == null) throw error(HttpStatus.CONFLICT, "There are no pending orders.");
            Order selected = order(id);
            if (cancel) for (OrderItem line : selected.items()) {
                if (jdbc.update("UPDATE products SET stock=stock+? WHERE id=? AND stock+?<=?", line.quantity(), line.productId(), line.quantity(), MAX_STOCK) != 1) throw error(HttpStatus.CONFLICT, "Restoring this order would exceed the stock limit. Adjust stock first.");
                recordStock(line.productId(), line.quantity(), "Cancelled checkout #" + id);
            }
            if (jdbc.update("UPDATE orders SET status=? WHERE id=? AND status='PENDING'", cancel ? "CANCELLED" : "FULFILLED", id) != 1) throw error(HttpStatus.CONFLICT, "The pending queue changed. Refresh and try again.");
            return order(id);
        });
    }
    public Dashboard dashboard() {
        List<Product> products = products();
        List<Order> orders = orders();
        long active = products.stream().filter(Product::active).count();
        long stock = products.stream().filter(Product::active).mapToLong(Product::stock).sum();
        long low = products.stream().filter(p -> p.active() && p.stock() <= p.reorderLevel()).count();
        long sales = orders.stream().filter(o -> !o.status().equals("CANCELLED")).mapToLong(Order::totalCents).sum();
        long pending = orders.stream().filter(o -> o.status().equals("PENDING")).count();
        List<TopProduct> top = jdbc.query("SELECT i.product_id, i.name, SUM(i.quantity) AS units, SUM(i.line_total_cents) AS sales FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.status<>'CANCELLED' GROUP BY i.product_id ORDER BY units DESC, i.product_id LIMIT 5", (row,index) -> new TopProduct(row.getLong("product_id"), row.getString("name"), row.getLong("units"), row.getLong("sales")));
        List<CategoryCount> categories = jdbc.query("SELECT category,COUNT(*) AS amount FROM products WHERE active=1 GROUP BY category ORDER BY category", (row,index) -> new CategoryCount(row.getString("category"), row.getLong("amount")));
        return new Dashboard(active, stock, low, sales, orders.size(), pending, orders.stream().limit(5).toList(), top, categories);
    }
    private void ensureUniqueSku(String sku, long id) {
        if (jdbc.queryForObject("SELECT COUNT(*) FROM products WHERE sku=? COLLATE NOCASE AND id<>?", Long.class, sku, id) != 0) throw error(HttpStatus.CONFLICT, "That SKU already exists.");
    }
    private void recordStock(long id, int delta, String reason) { jdbc.update("INSERT INTO stock_movements(product_id,delta,reason,created_at) VALUES (?,?,?,?)", id, delta, reason, Instant.now().toString()); }
    private void validateProduct(ProductInput input) {
        String sku = requiredText(input.sku(), "SKU", 32);
        if (!sku.matches("[A-Za-z0-9][A-Za-z0-9_-]*")) throw error(HttpStatus.BAD_REQUEST, "SKU must contain letters, numbers, hyphens, or underscores.");
        requiredText(input.name(), "Product name", 120); requiredText(input.category(), "Category", 60);
        if (input.priceCents() == null || input.priceCents() < 1 || input.priceCents() > 100_000_000L) throw error(HttpStatus.BAD_REQUEST, "Price must be between PKR 0.01 and PKR 1,000,000 in integer paisa.");
        if (input.stock() == null || input.stock() < 0 || input.stock() > MAX_STOCK || input.reorderLevel() == null || input.reorderLevel() < 0 || input.reorderLevel() > MAX_STOCK) throw error(HttpStatus.BAD_REQUEST, "Stock and reorder level must be whole numbers between 0 and 1,000,000.");
    }
    private String requiredText(String value, String field, int max) {
        if (value == null || value.isBlank() || value.trim().length() > max || value.codePoints().anyMatch(Character::isISOControl)) throw error(HttpStatus.BAD_REQUEST, field + " is required and must contain at most " + max + " printable characters.");
        return value.trim();
    }
    private static String digest(String text) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException exception) { throw new IllegalStateException(exception); }
    }
    private static ResponseStatusException error(HttpStatus status, String message) { return new ResponseStatusException(status,message); }
}
