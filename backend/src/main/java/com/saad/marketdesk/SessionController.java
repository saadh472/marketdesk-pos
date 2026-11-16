package com.saad.marketdesk;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpStatus;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.authentication.logout.SecurityContextLogoutHandler;
import org.springframework.security.web.authentication.session.ChangeSessionIdAuthenticationStrategy;
import org.springframework.security.web.context.SecurityContextRepository;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.security.web.csrf.CsrfTokenRepository;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api")
public class SessionController {
    private final AuthenticationManager manager;
    private final SecurityContextRepository contexts;
    private final CsrfTokenRepository csrf;
    public SessionController(AuthenticationManager manager, SecurityContextRepository contexts, CsrfTokenRepository csrf) {
        this.manager = manager; this.contexts = contexts; this.csrf = csrf;
    }
    public record Login(String username, String password) { }
    public record SessionUser(String username, String displayName) { }
    public record SessionView(boolean authenticated, String csrfToken, SessionUser user) { }
    @GetMapping("/session")
    SessionView session(Authentication authentication, CsrfToken token) {
        boolean signedIn = authentication != null && authentication.isAuthenticated();
        return new SessionView(signedIn, token.getToken(), signedIn ? new SessionUser(authentication.getName(), "Demo Manager") : null);
    }
    @PostMapping("/login")
    SessionView login(@RequestBody Login login, HttpServletRequest request, HttpServletResponse response) {
        if (login.username() == null || login.password() == null || login.username().length() > 100 || login.password().length() > 200) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Enter your username and password.");
        }
        try {
            Authentication authentication = manager.authenticate(UsernamePasswordAuthenticationToken.unauthenticated(login.username(), login.password()));
            new ChangeSessionIdAuthenticationStrategy().onAuthentication(authentication, request, response);
            var context = SecurityContextHolder.createEmptyContext();
            context.setAuthentication(authentication);
            SecurityContextHolder.setContext(context);
            contexts.saveContext(context, request, response);
            CsrfToken token = csrf.generateToken(request);
            csrf.saveToken(token, request, response);
            return session(authentication, token);
        } catch (AuthenticationException exception) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "The username or password is incorrect.");
        }
    }
    @PostMapping("/logout")
    SessionView logout(Authentication authentication, HttpServletRequest request, HttpServletResponse response) {
        new SecurityContextLogoutHandler().logout(request, response, authentication);
        CsrfToken token = csrf.generateToken(request);
        csrf.saveToken(token, request, response);
        return session(null, token);
    }
}
