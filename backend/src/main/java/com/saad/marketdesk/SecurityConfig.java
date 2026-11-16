package com.saad.marketdesk;

import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.authentication.ProviderManager;
import org.springframework.security.authentication.dao.DaoAuthenticationProvider;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.security.web.context.SecurityContextRepository;
import org.springframework.security.web.csrf.HttpSessionCsrfTokenRepository;
import org.springframework.security.web.csrf.CsrfTokenRepository;
import org.springframework.security.web.csrf.CsrfTokenRequestAttributeHandler;
import org.springframework.security.web.util.matcher.RegexRequestMatcher;

@Configuration
public class SecurityConfig {
    @Bean PasswordEncoder passwordEncoder() { return new BCryptPasswordEncoder(); }
    @Bean UserDetailsService users(PasswordEncoder encoder,
            @Value("${marketdesk.username}") String username, @Value("${marketdesk.password}") String password) {
        if (username.isBlank() || password.length() < 12 || password.length() > 72) {
            throw new IllegalStateException("Configure a username and a password between 12 and 72 characters.");
        }
        return new InMemoryUserDetailsManager(User.withUsername(username).password(encoder.encode(password)).roles("MANAGER").build());
    }
    @Bean AuthenticationManager authenticationManager(UserDetailsService users, PasswordEncoder encoder) {
        DaoAuthenticationProvider provider = new DaoAuthenticationProvider(users);
        provider.setPasswordEncoder(encoder);
        return new ProviderManager(provider);
    }
    @Bean SecurityContextRepository contextRepository() { return new HttpSessionSecurityContextRepository(); }
    @Bean CsrfTokenRepository csrfRepository() {
        HttpSessionCsrfTokenRepository repository = new HttpSessionCsrfTokenRepository();
        repository.setHeaderName("X-CSRF-TOKEN");
        return repository;
    }
    @Bean SecurityFilterChain security(HttpSecurity http, SecurityContextRepository contexts,
                                      CsrfTokenRepository csrf) throws Exception {
        http.authorizeHttpRequests(auth -> auth
                .requestMatchers("/api/session", "/api/login", "/api/health").permitAll()
                .requestMatchers("/api/**").authenticated()
                .requestMatchers(new RegexRequestMatcher("/(?:[^/]+/)*\\.[^/]+(?:/.*)?", null)).denyAll()
                .anyRequest().permitAll())
            .securityContext(context -> context.securityContextRepository(contexts))
            .csrf(config -> config.csrfTokenRepository(csrf).csrfTokenRequestHandler(new CsrfTokenRequestAttributeHandler()))
            .formLogin(config -> config.disable()).httpBasic(config -> config.disable())
            .logout(config -> config.disable())
            .requestCache(config -> config.disable())
            .exceptionHandling(config -> config
                .authenticationEntryPoint((request, response, exception) -> jsonError(response, 401, "Sign in to continue."))
                .accessDeniedHandler((request, response, exception) -> jsonError(response, 403, "Your session token is missing or expired. Reload and try again.")))
            .headers(headers -> headers
                .contentSecurityPolicy(csp -> csp.policyDirectives("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"))
                .frameOptions(frame -> frame.deny())
                .referrerPolicy(Customizer.withDefaults()));
        return http.build();
    }
    private static void jsonError(HttpServletResponse response, int status, String message) throws java.io.IOException {
        response.setStatus(status);
        response.setContentType("application/json");
        response.getWriter().write("{\"message\":\"" + message + "\"}");
    }
}
