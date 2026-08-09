package ir.jibit.projectx.config.security;

/**
 * Responsible for configuring the Security aspects of application.
 * A java class to test the path-scoped rules.
 *
 */
@EnableWebSecurity
@Configuration
@RequiredArgsConstructor
@EnableMethodSecurity(prePostEnabled = true, securedEnabled = true, jsr250Enabled = true)
public class SecurityConfig {

  private final RestAuthenticationEntryPoint authenticationEntryPoint;

  @Bean
  public SecurityFilterChain securityFilterChain(HttpSecurity http
      , JwtAuthenticationFilter jwtAuthenticationFilter) throws Exception {

     return authenticationEntryPoint.checkNext();
  }
}
