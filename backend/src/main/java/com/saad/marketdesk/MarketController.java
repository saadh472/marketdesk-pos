package com.saad.marketdesk;

import static com.saad.marketdesk.Models.*;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class MarketController {
    private final MarketService market;
    private final JdbcTemplate jdbc;
    public MarketController(MarketService market, JdbcTemplate jdbc) { this.market=market; this.jdbc=jdbc; }
    @GetMapping("/health") Map<String,String> health() { jdbc.queryForObject("SELECT 1", Integer.class); return Map.of("status","UP","application","marketdesk"); }
    @GetMapping("/products") List<Product> products() { return market.products(); }
    @PostMapping("/products") @ResponseStatus(org.springframework.http.HttpStatus.CREATED)
    Product add(@RequestBody ProductInput input) { return market.add(input); }
    @PutMapping("/products/{id}") Product update(@PathVariable long id, @RequestBody ProductInput input) { return market.update(id,input); }
    @PostMapping("/products/{id}/stock") Product stock(@PathVariable long id, @RequestBody StockInput input) { return market.adjustStock(id,input); }
    @GetMapping("/dashboard") Dashboard dashboard() { return market.dashboard(); }
    @GetMapping("/orders") List<Order> orders() { return market.orders(); }
    @PostMapping("/checkout") @ResponseStatus(org.springframework.http.HttpStatus.CREATED)
    Order checkout(@RequestBody CheckoutInput input) { return market.checkout(input); }
    @PostMapping("/orders/fulfill-next") Order fulfillNext() { return market.fulfillNext(); }
    @PostMapping("/orders/cancel-last") Order cancelLast() { return market.cancelLast(); }
}
