# MarketDesk walkthrough

Use fictional products and simulated cash. No real payment is processed.

## Open your store

Start the application with `launcher/Start MarketDesk.cmd`. Open the URL printed by the launcher, choose **Fill demo account**, and sign in with `admin` / `DemoPass123!`.

The initial overview contains eight active products. Plain Yogurt and Dishwashing Liquid start at or below their low-stock thresholds. Existing saved databases may show different totals from earlier testing.

## Complete a simulated sale

1. Open **Checkout** and search for **Basmati Rice**.
2. Add one unit. Its initial price is PKR 385.00.
3. Enter PKR 500.00 as cash received and choose **Complete checkout**.
4. The receipt shows PKR 115.00 change. The product's stock falls by one and a pending order appears under **Orders**.

The server uses its current price and inventory. If a product was edited earlier, the receipt reflects that saved price instead of the original seed value.

## Explore the queue and stack

Create another sale. Under **Orders**, **Fulfill next order** completes the oldest pending order (FIFO). **Cancel latest pending** opens a confirmation for the newest pending order (LIFO). Confirming cancellation restores its stock. Fulfilled receipts remain in history and are not cancelled by this operation.

The server selects the pending order when it receives the action. If another tab changes the queue, refresh before acting again.

## Maintain inventory

Open **Inventory** and choose **Add product**. Try SKU `DEMO-009`, name `Fictional Snack`, category `Snacks`, price `120.50`, stock `10`, and threshold `3`. Save it and search for the new product.

Choose **Edit** to update its details or archive it. Use **Stock** to change the count with a reason such as `Fictional delivery`. Stock edits are separate so the movement has an audit record. Existing receipts keep their original prices.

## Check persistence and retry behavior

Stop and restart MarketDesk. Sign in and confirm that the added product and receipts are still present. They are saved in the ignored local SQLite database.

If the connection fails during checkout, leave the basket unchanged and choose **Retry same checkout** when the server returns. Its original request ID recovers the same receipt. Other uncertain writes require refreshing and reviewing saved records before submitting again. Closing the browser tab before resolving a checkout can discard the tab's recovery information.
