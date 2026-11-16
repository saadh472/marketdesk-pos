package com.saad.marketdesk;

import java.util.Map;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.server.ResponseStatusException;

@RestControllerAdvice
public class ApiErrors {
    @ExceptionHandler(ResponseStatusException.class)
    ResponseEntity<Map<String,String>> status(ResponseStatusException exception) {
        return ResponseEntity.status(exception.getStatusCode()).body(Map.of("message", exception.getReason() == null ? "Request could not be completed." : exception.getReason()));
    }
    @ExceptionHandler(HttpMessageNotReadableException.class)
    ResponseEntity<Map<String,String>> json(HttpMessageNotReadableException exception) {
        return ResponseEntity.badRequest().body(Map.of("message","Send valid JSON with whole-number quantities and money in integer paisa."));
    }
    @ExceptionHandler(DataIntegrityViolationException.class)
    ResponseEntity<Map<String,String>> conflict(DataIntegrityViolationException exception) {
        return ResponseEntity.status(409).body(Map.of("message","This change conflicts with an existing record. Refresh and try again."));
    }
    @ExceptionHandler(DataAccessException.class)
    ResponseEntity<Map<String,String>> database(DataAccessException exception) {
        return ResponseEntity.status(503).header("Retry-After","2").body(Map.of("message","The database is temporarily unavailable. Reload the records before retrying."));
    }
}
