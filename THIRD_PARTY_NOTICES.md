# Third-party notices and license scope

## Original application code

The MIT license applies to the new Java backend, browser frontend, launchers, tests, and newly written documentation. The original coursework proposal and any legacy reference materials are excluded. The original POSSystem.java placeholder was retained without removing attribution.

The root [LICENSE](LICENSE) does not replace third-party licenses or grant rights to excluded legacy materials.

## Runtime dependencies

Dependencies are resolved through Maven and npm. Their upstream terms and notices continue to apply, including those included in their downloaded artifacts.

| Component | License | Primary source |
| --- | --- | --- |
| Spring Boot 3.5.16 and Spring framework/security components | Apache-2.0 | [Spring Boot license](https://github.com/spring-projects/spring-boot/blob/main/LICENSE.txt), [Spring Security license](https://github.com/spring-projects/spring-security/blob/main/LICENSE.txt) |
| Xerial SQLite JDBC 3.54.1.0 | Apache-2.0 / BSD-2-Clause terms in the upstream distribution | [SQLite JDBC license](https://github.com/xerial/sqlite-jdbc/blob/master/LICENSE) |

SQLite itself is [public-domain software](https://www.sqlite.org/copyright.html); the Java JDBC wrapper has its own upstream terms.

## Development tools and distribution

Maven/npm test and build dependencies retain their own licenses. Consult the lockfile, POM, and installed package notices for the exact resolved versions; this summary is not a complete transitive dependency inventory.

