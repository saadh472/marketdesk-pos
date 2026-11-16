# MarketDesk API

Java 17, Spring Boot, Spring Security, JdbcTemplate, and SQLite. The application serves the sibling `frontend/` directory and its API on one origin at `http://127.0.0.1:8081`.

Run `mvn spring-boot:run` from this directory, or build with `mvn verify` and run `java -jar target/marketdesk-1.0.0.jar`. The database is created under `backend/data/` when launched from this directory. The initial eight products and all account details are fictional. Cash checkout simulates tender and change; it does not take real payments.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `MARKETDESK_DB` | `./data/marketdesk.sqlite` | Persistent SQLite file; relative to the process working directory |
| `MARKETDESK_FRONTEND` | `../frontend` | Static frontend directory |
| `MARKETDESK_USERNAME` | `admin` | Manager username |
| `MARKETDESK_PASSWORD` | `DemoPass123!` | Local demo password; configure 12–72 characters to replace it |
| `PORT` | `8081` | HTTP port |
| `SERVER_ADDRESS` | `127.0.0.1` | Loopback binding |
| `COOKIE_SECURE` | `false` | Enable for a deployment served only over HTTPS |

The published demo credential is for localhost and fictional records. Public service hosting requires unique credentials, HTTPS, operational monitoring, rate limiting, and account administration. Sessions expire after 30 minutes of inactivity. Signing in rotates the session ID and CSRF token. Signing out invalidates the signed-in session. Accounts are configured from environment variables and passwords are BCrypt hashed in process memory; product and order data persist independently in SQLite.

## API

First request `GET /api/session`; keep the session cookie and its `csrfToken`. Send that token in `X-CSRF-TOKEN` on every POST and PUT, including login. Login and logout return a fresh session object and token. GET responses require no CSRF header. Browser requests should use the same origin.

| Method and route | Request / response |
| --- | --- |
| `GET /api/health` | Public `{status:"UP"}`; checks database availability |
| `GET /api/session` | Public `{authenticated,csrfToken,user}`; user is null when signed out |
| `POST /api/login` | `{username,password}` → session object |
| `POST /api/logout` | Sign out → anonymous session object |
| `GET /api/products` | Array of `{id,sku,name,category,priceCents,stock,reorderLevel,active}` |
| `POST /api/products` | Create product; same fields except ID, active defaults true |
| `PUT /api/products/{id}` | Full product fields; stock must match current stock |
| `POST /api/products/{id}/stock` | `{delta,reason}` → updated product; nonzero whole delta |
| `GET /api/dashboard` | Totals, pending count, recent orders, top products, category counts |
| `POST /api/checkout` | `{requestId,items:[{productId,quantity}],tenderedCents}` → order |
| `GET /api/orders` | Orders, newest first, with line-item price/name snapshots |
| `POST /api/orders/fulfill-next` | Fulfill oldest pending order (FIFO) |
| `POST /api/orders/cancel-last` | Cancel newest pending order and restore stock (LIFO) |

Orders use `PENDING`, `FULFILLED`, and `CANCELLED` statuses. Cents fields represent integer **paisa**: `12550` means PKR 125.50. Prices are snapshotted at checkout; old orders retain their original prices if the product changes later. Sales totals include pending and fulfilled orders and exclude cancelled ones. Reorder warnings include stock equal to the reorder threshold. Stock units and product totals count active products only.

Checkout requires a canonical UUID request ID. Reuse it only to retry the same cart and tender amount. Equivalent carts with reordered lines return the original order and never debit stock twice; a changed cart with an existing ID returns 409. A cancelled order remains cancelled on retry. Generate a new ID for each new sale. Each product may occur once per cart, quantities are 1–1,000, and carts have at most 100 products.

All stock changes and order creation occur in a single SQLite transaction. Failed stock checks or insufficient cash roll back the entire checkout. Cancellation restores all lines atomically; a fulfilled order cannot be cancelled by the pending-stack operation. SKU uniqueness is case insensitive. Archive products with `active:false` instead of deleting order history. Stock corrections require a reason and are recorded in a durable movement audit table.

The DSA operations are explicit in `MarketService`: an `ArrayList` forms the sortable product/cart working sets, a `HashMap` detects duplicate cart lines, and an `ArrayDeque` implements FIFO and LIFO operations. The deque is rebuilt from ordered, persisted pending IDs before each operation, so a restart cannot lose queue order. Database updates remain authoritative.

Errors return `{message}` with 400 for invalid input, 401 for a missing/expired login, 403 for an invalid session token, 404 for an unknown product, 409 for inventory or reuse conflicts, or 503 for an unavailable database. Uncertain checkout retries must retain the original request ID.

## Verification and storage

`mvn verify` covers sign-in and sign-out, CSRF protection, exact money, duplicate checkout retries, atomic rollback, invalid input, FIFO/LIFO behavior, stock restoration, and a real application-context restart against the same SQLite file. Tests use temporary databases and do not change the local demo database.

Schema version 1 is initialized transactionally and seeded once using `schema_metadata`. No destructive reset runs at startup. Back up the SQLite file using SQLite's backup command/API or stop the application and copy the database with its WAL companion if present. The application never uploads or commits database files. Data migrations beyond version 1 need an explicit migration step before deployment.

Dependency versions were checked against the primary Maven Central metadata: [Spring Boot](https://repo.maven.apache.org/maven2/org/springframework/boot/spring-boot-starter-parent/maven-metadata.xml) and [SQLite JDBC](https://repo.maven.apache.org/maven2/org/xerial/sqlite-jdbc/maven-metadata.xml).
