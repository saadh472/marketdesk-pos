package com.saad.marketdesk;

import static com.saad.marketdesk.Models.*;
import static org.assertj.core.api.Assertions.*;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;

class PersistenceIntegrationTest {
    @TempDir Path directory;
    private ConfigurableApplicationContext start(Path database) {
        return new SpringApplicationBuilder(MarketDeskApplication.class).run("--server.port=0", "--marketdesk.database="+database,
            "--marketdesk.username=admin", "--marketdesk.password=DemoPass123!", "--spring.main.banner-mode=off");
    }
    @Test void aNewApplicationContextReusesProductsOrdersAndPendingQueue() {
        Path database=directory.resolve("restart.sqlite");
        long productId;
        long firstOrder;
        long secondOrder;
        try (var first=start(database)) {
            MarketService market=first.getBean(MarketService.class);
            Product product=market.add(new ProductInput("RESTART-1","Restart fixture","Tests",129L,10,2,true));
            productId=product.id();
            firstOrder=market.checkout(new CheckoutInput(UUID.randomUUID().toString(),List.of(new CartItem(productId,2)),300L)).id();
            secondOrder=market.checkout(new CheckoutInput(UUID.randomUUID().toString(),List.of(new CartItem(productId,3)),400L)).id();
        }
        try (var second=start(database)) {
            MarketService market=second.getBean(MarketService.class);
            assertThat(market.products()).hasSize(9);
            assertThat(market.products().stream().filter(p->p.id()==productId).findFirst().orElseThrow().stock()).isEqualTo(5);
            assertThat(market.orders()).hasSize(2);
            assertThat(market.fulfillNext().id()).isEqualTo(firstOrder);
            assertThat(market.cancelLast().id()).isEqualTo(secondOrder);
            assertThat(market.products().stream().filter(p->p.id()==productId).findFirst().orElseThrow().stock()).isEqualTo(8);
        }
    }
}
