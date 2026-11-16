package com.saad.marketdesk;

import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

@SpringBootTest
@AutoConfigureMockMvc
class MarketIntegrationTest {
    static final Path DIRECTORY;
    static { try { DIRECTORY=Files.createTempDirectory("marketdesk-tests-"); } catch (Exception e) { throw new ExceptionInInitializerError(e); } }
    @DynamicPropertySource static void properties(DynamicPropertyRegistry registry) {
        registry.add("marketdesk.database", () -> DIRECTORY.resolve("integration.sqlite").toString());
        registry.add("marketdesk.username", () -> "admin");
        registry.add("marketdesk.password", () -> "DemoPass123!");
    }
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper mapper;
    record Client(MockHttpSession session,String csrf) { }
    private JsonNode json(MvcResult result) throws Exception { return mapper.readTree(result.getResponse().getContentAsString()); }
    private Client login() throws Exception {
        MvcResult anonymous=mvc.perform(get("/api/session")).andExpect(status().isOk()).andReturn();
        var session=(MockHttpSession)anonymous.getRequest().getSession();
        String token=json(anonymous).get("csrfToken").asText();
        var signedIn=mvc.perform(post("/api/login").session(session).header("X-CSRF-TOKEN",token).contentType("application/json").content("{\"username\":\"admin\",\"password\":\"DemoPass123!\"}")).andExpect(status().isOk()).andExpect(jsonPath("$.authenticated").value(true)).andReturn();
        return new Client(session,json(signedIn).get("csrfToken").asText());
    }
    private JsonNode createProduct(Client client,int stock,long cents) throws Exception {
        String body=mapper.writeValueAsString(Map.of("sku","TEST-"+UUID.randomUUID().toString().substring(0,8),"name","Integration product","category","Tests","priceCents",cents,"stock",stock,"reorderLevel",2,"active",true));
        return json(mvc.perform(post("/api/products").session(client.session).header("X-CSRF-TOKEN",client.csrf).contentType("application/json").content(body)).andExpect(status().isCreated()).andReturn());
    }
    private MvcResult checkout(Client client,String key,String items,long tendered,int expected) throws Exception {
        return mvc.perform(post("/api/checkout").session(client.session).header("X-CSRF-TOKEN",client.csrf).contentType("application/json").content("{\"requestId\":\""+key+"\",\"items\":"+items+",\"tenderedCents\":"+tendered+"}")).andExpect(status().is(expected)).andReturn();
    }
    private String item(long id,int quantity) { return "{\"productId\":"+id+",\"quantity\":"+quantity+"}"; }
    private int stock(Client client,long id) throws Exception {
        JsonNode products=json(mvc.perform(get("/api/products").session(client.session)).andExpect(status().isOk()).andReturn());
        for (JsonNode product:products) if (product.get("id").asLong()==id) return product.get("stock").asInt();
        throw new AssertionError("Missing product");
    }
    @Test void authenticationCsrfAndLogoutProtectTheWorkspace() throws Exception {
        mvc.perform(get("/api/health")).andExpect(status().isOk());
        mvc.perform(get("/api/products")).andExpect(status().isUnauthorized());
        mvc.perform(post("/api/login").contentType("application/json").content("{}")).andExpect(status().isForbidden());
        var anonymous=mvc.perform(get("/api/session")).andReturn();
        var session=(MockHttpSession)anonymous.getRequest().getSession();
        String oldToken=json(anonymous).get("csrfToken").asText();
        mvc.perform(post("/api/login").session(session).header("X-CSRF-TOKEN",oldToken).contentType("application/json").content("{\"username\":\"admin\",\"password\":\"wrong\"}")).andExpect(status().isUnauthorized());
        String oldSessionId=session.getId();
        var signedIn=mvc.perform(post("/api/login").session(session).header("X-CSRF-TOKEN",oldToken).contentType("application/json").content("{\"username\":\"admin\",\"password\":\"DemoPass123!\"}")).andExpect(status().isOk()).andReturn();
        Client client=new Client(session,json(signedIn).get("csrfToken").asText());
        assertThat(session.getId()).isNotEqualTo(oldSessionId);
        assertThat(client.csrf).isNotEqualTo(oldToken);
        mvc.perform(post("/api/logout").session(session).header("X-CSRF-TOKEN",oldToken)).andExpect(status().isForbidden());
        mvc.perform(get("/api/dashboard").session(client.session)).andExpect(status().isOk());
        mvc.perform(post("/api/products/1/stock").session(client.session).contentType("application/json").content("{\"delta\":1,\"reason\":\"test\"}")).andExpect(status().isForbidden());
        var loggedOut=mvc.perform(post("/api/logout").session(client.session).header("X-CSRF-TOKEN",client.csrf)).andExpect(status().isOk()).andExpect(jsonPath("$.authenticated").value(false)).andReturn();
        mvc.perform(get("/api/products").session((MockHttpSession)loggedOut.getRequest().getSession())).andExpect(status().isUnauthorized());
    }
    @Test void checkoutUsesExactMoneyAndIdempotentPayloadMatching() throws Exception {
        Client client=login();
        long first=createProduct(client,20,101).get("id").asLong();
        long second=createProduct(client,20,203).get("id").asLong();
        String key=UUID.randomUUID().toString();
        JsonNode order=json(checkout(client,key,"["+item(first,3)+","+item(second,2)+"]",1000,201));
        assertThat(order.get("totalCents").asLong()).isEqualTo(709);
        assertThat(order.get("changeCents").asLong()).isEqualTo(291);
        JsonNode retry=json(checkout(client,key,"["+item(second,2)+","+item(first,3)+"]",1000,201));
        assertThat(retry.get("id")).isEqualTo(order.get("id"));
        assertThat(stock(client,first)).isEqualTo(17);
        checkout(client,key,"["+item(first,4)+","+item(second,2)+"]",1000,409);
        assertThat(stock(client,first)).isEqualTo(17);
    }
    @Test void failedCartsRollbackEveryStockChange() throws Exception {
        Client client=login();
        long first=createProduct(client,20,101).get("id").asLong();
        long second=createProduct(client,0,203).get("id").asLong();
        checkout(client,UUID.randomUUID().toString(),"["+item(first,3)+","+item(second,1)+"]",10000,409);
        assertThat(stock(client,first)).isEqualTo(20);
        checkout(client,UUID.randomUUID().toString(),"["+item(first,3)+"]",1,400);
        assertThat(stock(client,first)).isEqualTo(20);
        checkout(client,UUID.randomUUID().toString(),"["+item(first,1)+","+item(first,1)+"]",10000,400);
        checkout(client,UUID.randomUUID().toString(),"["+item(first,-1)+"]",10000,400);
        assertThat(stock(client,first)).isEqualTo(20);
    }
    @Test void pendingOrdersUseFifoAndLifoAndCancellationRestoresStockOnce() throws Exception {
        Client client=login();
        // Clear pending orders left by other independently executed integration tests.
        JsonNode all=json(mvc.perform(get("/api/orders").session(client.session)).andReturn());
        for(JsonNode order:all) if(order.get("status").asText().equals("PENDING")) mvc.perform(post("/api/orders/cancel-last").session(client.session).header("X-CSRF-TOKEN",client.csrf)).andExpect(status().isOk());
        long product=createProduct(client,100,100).get("id").asLong();
        JsonNode first=json(checkout(client,UUID.randomUUID().toString(),"["+item(product,1)+"]",100,201));
        JsonNode second=json(checkout(client,UUID.randomUUID().toString(),"["+item(product,2)+"]",200,201));
        String thirdKey=UUID.randomUUID().toString();
        JsonNode third=json(checkout(client,thirdKey,"["+item(product,3)+"]",300,201));
        var fulfilled=json(mvc.perform(post("/api/orders/fulfill-next").session(client.session).header("X-CSRF-TOKEN",client.csrf)).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("FULFILLED")).andReturn());
        assertThat(fulfilled.get("id")).isEqualTo(first.get("id"));
        var cancelled=json(mvc.perform(post("/api/orders/cancel-last").session(client.session).header("X-CSRF-TOKEN",client.csrf)).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("CANCELLED")).andReturn());
        assertThat(cancelled.get("id")).isEqualTo(third.get("id"));
        assertThat(stock(client,product)).isEqualTo(97);
        assertThat(json(checkout(client,thirdKey,"["+item(product,3)+"]",300,201)).get("status").asText()).isEqualTo("CANCELLED");
        assertThat(stock(client,product)).isEqualTo(97);
        assertThat(second.get("id").asLong()).isGreaterThan(first.get("id").asLong());
    }
    @Test void productAndStockValidationPreserveExistingRecords() throws Exception {
        Client client=login();
        JsonNode product=createProduct(client,5,100).deepCopy();
        long id=product.get("id").asLong();
        mvc.perform(post("/api/products/"+id+"/stock").session(client.session).header("X-CSRF-TOKEN",client.csrf).contentType("application/json").content("{\"delta\":-6,\"reason\":\"count correction\"}")).andExpect(status().isConflict());
        assertThat(stock(client,id)).isEqualTo(5);
        mvc.perform(post("/api/products/"+id+"/stock").session(client.session).header("X-CSRF-TOKEN",client.csrf).contentType("application/json").content("{\"delta\":2,\"reason\":\"delivery\"}")).andExpect(status().isOk()).andExpect(jsonPath("$.stock").value(7));
        mvc.perform(post("/api/products/"+id+"/stock").session(client.session).header("X-CSRF-TOKEN",client.csrf).contentType("application/json").content("{\"delta\":1.5,\"reason\":\"invalid\"}")).andExpect(status().isBadRequest());
        mvc.perform(post("/api/products").session(client.session).header("X-CSRF-TOKEN",client.csrf).contentType("application/json").content(mapper.writeValueAsString(Map.of("sku",product.get("sku").asText().toLowerCase(),"name","Duplicate","category","Tests","priceCents",100,"stock",1,"reorderLevel",0)))).andExpect(status().isConflict());
    }
    @Test void concurrentCheckoutsCannotOversellOrDebitARetryTwice() throws Exception {
        Client client=login();
        long limited=createProduct(client,1,100).get("id").asLong();
        var pool=Executors.newFixedThreadPool(2);
        try {
            Callable<Integer> purchase=() -> mvc.perform(post("/api/checkout").session(client.session).header("X-CSRF-TOKEN",client.csrf).contentType("application/json").content("{\"requestId\":\""+UUID.randomUUID()+"\",\"items\":["+item(limited,1)+"],\"tenderedCents\":100}")).andReturn().getResponse().getStatus();
            var results=pool.invokeAll(java.util.List.of(purchase,purchase));
            assertThat(java.util.List.of(results.get(0).get(),results.get(1).get())).containsExactlyInAnyOrder(201,409);
            assertThat(stock(client,limited)).isZero();
            long retryProduct=createProduct(client,10,100).get("id").asLong();
            String key=UUID.randomUUID().toString();
            Callable<JsonNode> retry=() -> json(checkout(client,key,"["+item(retryProduct,2)+"]",200,201));
            var repeated=pool.invokeAll(java.util.List.of(retry,retry));
            assertThat(repeated.get(0).get().get("id")).isEqualTo(repeated.get(1).get().get("id"));
            assertThat(stock(client,retryProduct)).isEqualTo(8);
        } finally { pool.shutdownNow(); }
    }
}
