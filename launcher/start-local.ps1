param([switch]$NoBrowser,[switch]$CheckOnly,[switch]$Rebuild,[ValidateRange(1024,65535)][int]$Port=8091)
$ErrorActionPreference='Stop'
$started=[Diagnostics.Stopwatch]::StartNew()
$projectRoot=Split-Path -Parent $PSScriptRoot
$backendRoot=Join-Path $projectRoot 'backend'
$frontendRoot=Join-Path $projectRoot 'frontend'
$cacheRoot=Join-Path $PSScriptRoot '.cache'
New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
$statePath=Join-Path $cacheRoot 'build-state.json'
$state=@{}
if(Test-Path -LiteralPath $statePath) {
  try { $saved=Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json; foreach($property in $saved.PSObject.Properties) { $state[$property.Name]=$property.Value } } catch {}
}
function Get-Fingerprint([string[]]$Paths) {
  $files=foreach($item in $Paths) {
    if(Test-Path -LiteralPath $item -PathType Container) { Get-ChildItem -LiteralPath $item -Recurse -File }
    elseif(Test-Path -LiteralPath $item -PathType Leaf) { Get-Item -LiteralPath $item }
  }
  $entries=foreach($file in ($files | Sort-Object FullName)) { $file.FullName+':'+(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash }
  return Get-TextHash ($entries -join [Environment]::NewLine)
}
function Get-TextHash([string]$Value) {
  $hasher=[Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace('-','') } finally { $hasher.Dispose() }
}
function Save-State {
  $temporary=Join-Path $cacheRoot ('build-state-'+[guid]::NewGuid().ToString('N')+'.tmp')
  $state | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $statePath -Force
}
function Find-Instance([int]$Candidate) {
  try { $health=Invoke-RestMethod -Uri "http://127.0.0.1:$Candidate/api/health" -TimeoutSec 1; return $health.application -eq 'marketdesk' } catch { return $false }
}
function Open-Existing([int]$Candidate) {
  $url="http://127.0.0.1:$Candidate"
  Write-Host "MarketDesk is already running: $url" -ForegroundColor Green
  if(!$NoBrowser -and !$CheckOnly) { Start-Process $url }
}
if(!$Rebuild -and (Find-Instance $Port)) { Open-Existing $Port; return }
$projectHash=(Get-TextHash $projectRoot.ToLowerInvariant()).Substring(0,20)
$mutex=New-Object Threading.Mutex($false,("Local\MarketDeskLaunch-"+$projectHash))
$ownsMutex=$false
$process=$null
try {
  Write-Host 'Checking MarketDesk...' -ForegroundColor Cyan
  try { $ownsMutex=$mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex=$true }
  if(!$ownsMutex) {
    Write-Host 'Another launcher is preparing this project. Waiting for its result...'
    try { $ownsMutex=$mutex.WaitOne(120000) } catch [Threading.AbandonedMutexException] { $ownsMutex=$true }
    if(!$ownsMutex) { throw 'Another startup is still running. Check its terminal for progress.' }
  }
  $requestedPort=$Port; $availablePort=$null
  foreach($candidatePort in $requestedPort..([Math]::Min(65535,$requestedPort+20))) {
    if(Find-Instance $candidatePort) {
      if($Rebuild) { throw "MarketDesk is running on $candidatePort. Close its launcher before forcing a rebuild." }
      Open-Existing $candidatePort; return
    }
    $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$candidatePort)
    try { $listener.ExclusiveAddressUse=$true; $listener.Start(); $availablePort=$candidatePort; break } catch {} finally { $listener.Stop() }
  }
  if($null -eq $availablePort) { throw 'No free local port was found. Run this script with -Port 18095.' }
  $Port=$availablePort
  if($Port -ne $requestedPort) { Write-Host "Port $requestedPort is occupied. Using $Port automatically." }
  $compiler=Get-Command javac.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  $candidates=@($env:JAVA_HOME)
  if($compiler) { $candidates+=Split-Path -Parent (Split-Path -Parent $compiler.Source) }
  $javaPath=$null
  foreach($candidate in $candidates) {
    if(!$candidate) { continue }
    $javaCandidate=Join-Path $candidate 'bin/java.exe'; $javacCandidate=Join-Path $candidate 'bin/javac.exe'
    if((Test-Path -LiteralPath $javaCandidate) -and (Test-Path -LiteralPath $javacCandidate)) {
      $version=& $javacCandidate -version
      if($version -match '^javac (17|21|25)(\.|$)') { $env:JAVA_HOME=$candidate; $javaPath=$javaCandidate; break }
    }
  }
  if(!$javaPath) { throw 'JDK 17, 21, or 25 is required. Set JAVA_HOME or put javac on PATH.' }
  if(!(Test-Path -LiteralPath (Join-Path $frontendRoot 'index.html'))) { throw 'The browser interface is missing frontend/index.html.' }
  Write-Host 'Browser interface is ready: no frontend build is required.'
  $backendHash=Get-Fingerprint @((Join-Path $backendRoot 'pom.xml'),(Join-Path $backendRoot 'src/main'))
  $jar=Join-Path $backendRoot 'target/marketdesk-1.0.0.jar'
  if($Rebuild -or !(Test-Path -LiteralPath $jar) -or $state.backend -ne $backendHash) {
    $maven=Get-Command mvn.cmd -ErrorAction SilentlyContinue
    if(!$maven) { throw 'Maven 3.9 or newer is required when backend source changes.' }
    Write-Host 'Building the changed Java backend...'
    Push-Location -LiteralPath $backendRoot
    try {
      & $maven.Source --batch-mode -DskipTests package
      if($LASTEXITCODE -ne 0) { throw 'Backend build failed. Fix the reported error before starting.' }
      $state.backend=$backendHash; Save-State
    } finally { Pop-Location }
  } else { Write-Host 'Backend unchanged: using the cached application build.' }
  $runtimeKey=$backendHash+':'+$javaPath
  $runtimeReady=$state.runtimeKey -eq $runtimeKey -and $state.runtimeDirectory -and (Test-Path -LiteralPath (Join-Path $state.runtimeDirectory 'application.jar'))
  if(!$runtimeReady) {
    $localRoot=[Environment]::GetFolderPath('LocalApplicationData')
    if(!$localRoot) { $localRoot=[IO.Path]::GetTempPath() }
    $projectRuntime=Join-Path $localRoot ('MarketDesk\runtime\'+$projectHash)
    New-Item -ItemType Directory -Path $projectRuntime -Force | Out-Null
    # A new destination avoids overwriting a running instance or deleting any user file.
    $runtimeDirectory=Join-Path $projectRuntime ($backendHash.Substring(0,16)+'-'+[guid]::NewGuid().ToString('N'))
    Write-Host 'Preparing the local runtime cache (only after backend changes)...'
    & $javaPath '-Djarmode=tools' '-jar' $jar 'extract' '--destination' $runtimeDirectory '--application-filename' 'application.jar'
    if($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath (Join-Path $runtimeDirectory 'application.jar'))) { throw 'The local Java runtime cache could not be prepared.' }
    $state.runtimeKey=$runtimeKey; $state.runtimeDirectory=$runtimeDirectory; Save-State
  } else { $runtimeDirectory=$state.runtimeDirectory; Write-Host 'Runtime unchanged: using extracted dependencies from the local disk.' }
  $env:PORT="$Port"; $env:SERVER_ADDRESS='127.0.0.1'; $env:MARKETDESK_FRONTEND=$frontendRoot
  if(!$env:MARKETDESK_DB) { $env:MARKETDESK_DB=Join-Path $backendRoot 'data/marketdesk.sqlite' }
  $databasePath=[IO.Path]::GetFullPath($env:MARKETDESK_DB); $env:MARKETDESK_DB=$databasePath
  $databaseParent=Split-Path -Parent $databasePath
  New-Item -ItemType Directory -Path $databaseParent -Force | Out-Null
  $logRoot=Join-Path ([IO.Path]::GetTempPath()) ('marketdesk-'+[guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $logRoot | Out-Null
  Write-Host 'Starting the complete application...'
  $process=Start-Process -FilePath $javaPath -ArgumentList @('-jar','application.jar') -WorkingDirectory $runtimeDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logRoot 'server.log') -RedirectStandardError (Join-Path $logRoot 'server.err.log')
  $url="http://127.0.0.1:$Port"; $ready=$false; $deadline=[DateTime]::UtcNow.AddSeconds(150); $nextNotice=[DateTime]::UtcNow.AddSeconds(15)
  do {
    if($process.HasExited) { throw "Java stopped before startup completed. Logs: $logRoot" }
    if(Find-Instance $Port) { $ready=$true; break }
    if([DateTime]::UtcNow -ge $nextNotice) { Write-Host "Waiting for Java to finish starting... Logs: $logRoot"; $nextNotice=[DateTime]::UtcNow.AddSeconds(15) }
    Start-Sleep -Milliseconds 300
  } while([DateTime]::UtcNow -lt $deadline)
  if(!$ready) { throw "Startup timed out. Inspect $logRoot" }
  Write-Host ("MarketDesk ready in {0:N1}s: {1}" -f $started.Elapsed.TotalSeconds,$url) -ForegroundColor Green
  Write-Host "Logs: $logRoot"
  $mutex.ReleaseMutex(); $ownsMutex=$false
  if($CheckOnly) { return }
  if(!$NoBrowser) { Start-Process $url }
  Write-Host 'Keep this terminal open. Ctrl+C stops only the instance started here.'
  while(!$process.HasExited) { Start-Sleep -Seconds 1 }
  throw "MarketDesk stopped. Logs: $logRoot"
} finally {
  if($process -and !$process.HasExited) { Stop-Process -Id $process.Id -ErrorAction SilentlyContinue; $process.WaitForExit(5000) | Out-Null }
  if($ownsMutex) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}

