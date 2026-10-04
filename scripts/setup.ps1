[CmdletBinding()]
param([switch]$Stop, [int]$Port = 0, [switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($PSVersionTable.PSEdition -eq 'Desktop') {
    # Cursor may launch Windows PowerShell from a PowerShell 7 environment.
    $env:PSModulePath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules;$env:ProgramFiles\WindowsPowerShell\Modules;$env:PSModulePath"
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$local = Join-Path $root '.local'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$lock = $null
$stage = 'Starting setup'

function Write-JsonFile($file, $value) {
    $temp = "$file.$([Guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($temp, ($value | ConvertTo-Json -Depth 20), $utf8)
    Move-Item -LiteralPath $temp -Destination $file -Force
}
function Read-JsonFile($file) {
    if (Test-Path -LiteralPath $file) { return Get-Content -LiteralPath $file -Raw | ConvertFrom-Json }
    return $null
}
function Step($message) { $script:stage = $message; Write-Host $message }
function Refresh-Path {
    $env:PATH = "$env:PATH;$([Environment]::GetEnvironmentVariable('PATH', 'User'));$([Environment]::GetEnvironmentVariable('PATH', 'Machine'));$env:LOCALAPPDATA\cursor-agent"
}
function Runtime {
    try { return Invoke-RestMethod "$script:base/api/runtime" -TimeoutSec 3 } catch { return $null }
}
function Assert-Owned($runtime, $id) {
    if ($runtime.application -ne 'branch-sync-workbench' -or $runtime.checkoutId -ne $id) {
        throw "Port $Port belongs to another application or checkout. Close it, or run: powershell.exe -File .\scripts\setup.ps1 -Port 4318"
    }
}
function Stop-Owned($runtime, $id) {
    Assert-Owned $runtime $id
    if ($runtime.activeJobs -gt 0) { throw 'Jobs are still active. Finish or cancel them in Activity, then run the launcher again.' }
    if (-not $runtime.canStop) { throw 'This server was started in development mode. Stop it in its terminal, then retry.' }
    $session = Invoke-RestMethod "$script:base/api/session" -TimeoutSec 3
    $null = Invoke-RestMethod "$script:base/api/runtime/stop" -Method Post -ContentType 'application/json' -Body '{}' -Headers @{ 'x-sync-token' = $session.token } -TimeoutSec 5
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 250
        if (-not (Runtime)) { return }
    }
    throw 'The server is still stopping. Wait briefly and retry. No process was forcibly terminated.'
}
function Open-Workbench {
    if (-not $NoBrowser) { Start-Process "$script:base/" }
    Write-Host "Workbench is ready: $script:base"
    Write-Host 'Choose repositories in the web app. Use Stop Workbench.cmd to stop the server.'
}
function Capture-Tool([string]$File, [string[]]$Arguments, [int]$Timeout = 60000) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $File
    $info.WorkingDirectory = $root
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    # All callers provide fixed command arguments or script paths, never shell text.
    $info.Arguments = ($Arguments | ForEach-Object { '"' + ($_ -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"' }) -join ' '
    $child = New-Object Diagnostics.Process
    $child.StartInfo = $info
    try {
        $null = $child.Start()
        $outTask = $child.StandardOutput.ReadToEndAsync()
        $errTask = $child.StandardError.ReadToEndAsync()
        if (-not $child.WaitForExit($Timeout)) { $child.Kill(); throw 'A prerequisite check timed out. Check the tool and network connection, then retry.' }
        return @{ Code = $child.ExitCode; Output = $outTask.Result; Error = $errTask.Result }
    } finally { $child.Dispose() }
}
function Run-Npm([string[]]$Arguments) {
    $result = Capture-Tool -File $script:node -Arguments (@($script:npmCli, '--prefix', $root) + $Arguments) -Timeout 900000
    # Authentication output never enters the setup log.
    $diagnostics = ($result.Output + $result.Error) -replace '(https?://)[^/\s:@]+:[^/\s@]+@', '$1[redacted]@'
    $diagnostics = $diagnostics -replace '(?i)((?:_authToken|authorization|token|password)\s*[=:]\s*)\S+', '$1[redacted]'
    [IO.File]::AppendAllText((Join-Path $local 'setup.log'), $diagnostics, $utf8)
    if ($result.Code -ne 0) { throw 'Package installation or build failed. Check .local\setup.log, fix the reported issue, then run setup again.' }
}
function Resolve-CursorCli {
    $onPath = Get-Command agent.exe -ErrorAction SilentlyContinue
    if ($onPath) { return @{ File = $onPath.Source; Prefix = @() } }
    $versions = Join-Path $env:LOCALAPPDATA 'cursor-agent\versions'
    if (-not (Test-Path -LiteralPath $versions)) { return $null }
    $version = Get-ChildItem -LiteralPath $versions -Directory | Where-Object {
        $_.Name -match '^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$'
    } | Sort-Object {
        $match = [regex]::Match($_.Name, '^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?')
        [int64]($match.Groups[1].Value + $match.Groups[2].Value.PadLeft(2, '0') + $match.Groups[3].Value.PadLeft(2, '0') + $(if ($match.Groups[4].Success) { $match.Groups[4].Value } else { '00' }) + $(if ($match.Groups[5].Success) { $match.Groups[5].Value } else { '00' }) + $(if ($match.Groups[6].Success) { $match.Groups[6].Value } else { '00' }))
    } -Descending | Select-Object -First 1
    if (-not $version) { return $null }
    $node = Join-Path $version.FullName 'node.exe'
    $index = Join-Path $version.FullName 'index.js'
    if ((Test-Path -LiteralPath $node) -and (Test-Path -LiteralPath $index)) {
        return @{ File = $node; Prefix = @($index) }
    }
    return $null
}
function Compatible-Node($candidate) {
    if (-not $candidate -or -not (Test-Path -LiteralPath $candidate)) { return $false }
    $cli = Join-Path (Split-Path $candidate) 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path -LiteralPath $cli)) { return $false }
    $version = & $candidate --version
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v24\.') { return $false }
    $npmVersion = & $candidate $cli --version
    return ($LASTEXITCODE -eq 0 -and $npmVersion -match '^11\.')
}

try {
    $null = New-Item -ItemType Directory -Path $local -Force
    try { $lock = [IO.File]::Open((Join-Path $local 'launcher.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch { throw 'Another setup or launcher is running for this checkout. Wait for it to finish, then retry.' }
    Set-Location -LiteralPath $root
    $metadata = Read-JsonFile (Join-Path $local 'runtime.json')
    if (-not $Port) {
        if ($env:SYNC_PORT) { $Port = [int]$env:SYNC_PORT }
        elseif ($metadata -and $metadata.root -eq $root) { $Port = [int]$metadata.port }
        else { $Port = 4317 }
    }
    if ($Port -lt 1 -or $Port -gt 65535) { throw 'Choose a port from 1 to 65535.' }
    $script:base = "http://127.0.0.1:$Port"
    if ($Stop) {
        if (-not $metadata -or $metadata.root -ne $root) { throw 'No owned server metadata exists for this checkout. Stop a manually started server in its terminal.' }
        $running = Runtime
        if ($running) { Stop-Owned $running $metadata.checkoutId; Write-Host 'Workbench stopped.' }
        else { Write-Host 'Workbench is not running.' }
        return
    }

    Step 'Checking Node.js and npm...'
    $script:node = $null
    $installedNode = Get-Command node.exe -ErrorAction SilentlyContinue
    $nodeRecord = Read-JsonFile (Join-Path $local 'node.json')
    if ($installedNode -and (Compatible-Node $installedNode.Source)) { $script:node = $installedNode.Source }
    elseif ($nodeRecord -and (Compatible-Node $nodeRecord.path)) { $script:node = $nodeRecord.path }
    else {
        Step 'Installing a private Node.js 24 runtime...'
        $architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
        $releases = Invoke-RestMethod 'https://nodejs.org/dist/index.json' -TimeoutSec 60
        $release = $releases | Where-Object { $_.version -match '^v24\.' -and $_.npm -match '^11\.' -and $_.files -contains "win-$architecture-zip" } | Select-Object -First 1
        if (-not $release) { throw 'No compatible Node.js 24 download was found. Check network access to nodejs.org and retry.' }
        $name = "node-$($release.version)-win-$architecture"
        $tools = Join-Path $local 'tools'
        $null = New-Item -ItemType Directory -Path $tools -Force
        $archive = Join-Path $tools "$name.zip"
        $checksums = (Invoke-WebRequest "https://nodejs.org/dist/$($release.version)/SHASUMS256.txt" -UseBasicParsing -TimeoutSec 60).Content
        $pattern = '(?m)^([a-f0-9]{64})\s+' + [regex]::Escape("$name.zip") + '\s*$'
        $match = [regex]::Match($checksums, $pattern)
        if (-not $match.Success) { throw 'The Node.js checksum could not be verified. Retry setup.' }
        Invoke-WebRequest "https://nodejs.org/dist/$($release.version)/$name.zip" -OutFile $archive -UseBasicParsing -TimeoutSec 180
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $match.Groups[1].Value) { throw 'Node.js download checksum mismatch. Retry setup to download it again.' }
        Expand-Archive -LiteralPath $archive -DestinationPath $tools -Force
        $script:node = Join-Path $tools "$name\node.exe"
        if (-not (Compatible-Node $script:node)) { throw 'The downloaded runtime did not pass its version checks.' }
        Write-JsonFile (Join-Path $local 'node.json') @{ path = $script:node }
    }
    $script:npmCli = Join-Path (Split-Path $script:node) 'node_modules\npm\bin\npm-cli.js'
    Refresh-Path
    $env:PATH = "$(Split-Path $script:node);$env:PATH"
    $stateText = & $script:node (Join-Path $PSScriptRoot 'workbench-state.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect build inputs. Check the checkout and retry.' }
    $state = $stateText | ConvertFrom-Json
    $running = Runtime
    if ($running) {
        Assert-Owned $running $state.checkoutId
        if ($running.buildFingerprint -ne $state.fingerprint) { Stop-Owned $running $state.checkoutId; $running = $null }
    } else {
        $connection = New-Object Net.Sockets.TcpClient
        try { $connection.Connect('127.0.0.1', $Port); throw "Port $Port is busy. Close the application using it, or run: powershell.exe -File .\scripts\setup.ps1 -Port 4318" }
        catch [Net.Sockets.SocketException] {} finally { $connection.Dispose() }
    }

    Step 'Checking Git...'
    if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
        if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) { throw 'Install Git for Windows from https://git-scm.com/download/win, then rerun setup. Automatic installation requires Windows App Installer (WinGet).' }
        & winget.exe install --id Git.Git --exact --source winget --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0) { throw 'Git installation was blocked or cancelled. Install Git for Windows, then rerun setup.' }
        Refresh-Path
    }
    & git.exe --version | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Git is not working. Repair Git for Windows, then rerun setup.' }

    $bindingsFile = Join-Path $local 'bindings.json'
    $bindings = Read-JsonFile $bindingsFile
    $provider = if ($bindings -and $bindings.defaultProvider) { $bindings.defaultProvider } elseif ($bindings) { 'codex' } else { 'cursor' }
    if ($provider -eq 'cursor') {
        Step 'Checking Cursor CLI...'
        $cursorCli = Resolve-CursorCli
        if (-not $cursorCli) {
            if (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'cursor-agent')) {
                throw 'A Cursor CLI installation exists but its launcher is missing. Repair the CLI using Cursor installation instructions, then retry; setup will not overwrite that installation.'
            }
            Step 'Installing Cursor CLI...'
            $installer = Join-Path $local 'install-cursor.ps1'
            Invoke-WebRequest 'https://cursor.com/install?win32=true' -OutFile $installer -UseBasicParsing -TimeoutSec 60
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer
            if ($LASTEXITCODE -ne 0) { throw 'Cursor CLI installation failed. Check network access and rerun setup.' }
            Refresh-Path
            $cursorCli = Resolve-CursorCli
            if (-not $cursorCli) { throw 'Cursor CLI installation failed. Check network access and rerun setup.' }
        }
        $agentVersion = Capture-Tool -File $cursorCli.File -Arguments (@($cursorCli.Prefix) + @('--version'))
        if ($agentVersion.Code -ne 0) { throw 'Cursor CLI is installed but cannot start. Repair it using Cursor CLI installation instructions, then retry.' }
        $acpHelp = Capture-Tool -File $cursorCli.File -Arguments (@($cursorCli.Prefix) + @('acp', '--help'))
        if ($acpHelp.Code -ne 0 -or ($acpHelp.Output + $acpHelp.Error) -notmatch 'acp') { throw 'Cursor CLI needs ACP support. Run agent update, then rerun setup.' }
        Step 'Checking Cursor sign-in...'
        $auth = & $script:node (Join-Path $PSScriptRoot 'cursor-status.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Could not check Cursor sign-in. Check the CLI and retry.' }
        if ($auth -eq 'unauthenticated') {
            Write-Host 'Complete Cursor sign-in in your browser. Setup will continue afterward.'
            & $cursorCli.File @(@($cursorCli.Prefix) + @('login'))
            if ($LASTEXITCODE -ne 0) { throw 'Cursor sign-in was cancelled or failed. Run setup again when ready.' }
            $auth = & $script:node (Join-Path $PSScriptRoot 'cursor-status.mjs')
        }
        if ($auth -ne 'authenticated') { throw 'Cursor sign-in could not be confirmed. Run agent status to check your account or connection, then retry setup.' }
    }
    if (-not $bindings) { Write-JsonFile $bindingsFile @{ version = 1; pairs = @{}; defaultProvider = 'cursor' } }

    $buildFile = Join-Path $local 'build.json'
    $built = Read-JsonFile $buildFile
    $dependencyFile = Join-Path $local 'dependencies.json'
    $dependencies = Read-JsonFile $dependencyFile
    if (-not $dependencies -or $dependencies.install -ne $state.install -or -not (Test-Path -LiteralPath (Join-Path $root 'node_modules\.package-lock.json'))) {
        if ($running) { Stop-Owned $running $state.checkoutId; $running = $null }
        Step 'Installing project dependencies...'
        Run-Npm -Arguments @('ci', '--no-audit', '--no-fund')
        Write-JsonFile $dependencyFile @{ install = $state.install }
        $built = $null
    }
    if (-not $built -or $built.fingerprint -ne $state.fingerprint -or -not (Test-Path -LiteralPath (Join-Path $root 'packages\server\dist\index.js')) -or -not (Test-Path -LiteralPath (Join-Path $root 'packages\web\dist\index.html')) -or -not (Test-Path -LiteralPath (Join-Path $root 'packages\engine\dist\index.js'))) {
        if ($running) { Stop-Owned $running $state.checkoutId; $running = $null }
        Step 'Building the workbench...'
        Run-Npm -Arguments @('run', 'build')
        Write-JsonFile $buildFile @{ fingerprint = $state.fingerprint }
    }
    if ($running) {
        Write-JsonFile (Join-Path $local 'runtime.json') @{ root = $root; checkoutId = $state.checkoutId; port = $Port; pid = $running.pid }
        Open-Workbench; return
    }
    Step 'Starting the workbench...'
    $env:SYNC_PORT = "$Port"
    # WMI creates the server independently of Cursor's terminal pipes and job.
    # A normal child process can retain those pipes even after setup has exited.
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{
        ShowWindow = [uint16]0
        WinstationDesktop = 'winsta0\default'
        EnvironmentVariables = [string[]](Get-ChildItem Env: | ForEach-Object { "$($_.Name)=$($_.Value)" })
    }
    $command = '"' + $script:node + '" "' + (Join-Path $PSScriptRoot 'background-server.mjs') + '"'
    $launch = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = $command; CurrentDirectory = $root; ProcessStartupInformation = $startup
    }
    if ($launch.ReturnValue -ne 0) { throw 'Windows could not start the background server. Check system policy for WMI process creation, then retry.' }
    $launchedPid = [int]$launch.ProcessId
    Write-JsonFile (Join-Path $local 'runtime.json') @{ root = $root; checkoutId = $state.checkoutId; port = $Port; pid = $launchedPid }
    for ($i = 0; $i -lt 60; $i++) {
        $ready = Runtime
        if ($ready) { Assert-Owned $ready $state.checkoutId; Open-Workbench; return }
        if (-not (Get-Process -Id $launchedPid -ErrorAction SilentlyContinue)) { throw 'The server could not start. Check .local\server-error.log, then retry.' }
        Start-Sleep -Milliseconds 500
    }
    throw 'The server did not become ready. Check .local\server-error.log, then rerun setup.'
} catch {
    Write-Host "Setup stopped: $stage" -ForegroundColor Yellow
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host 'After fixing the issue, rerun /setup or double-click Start Workbench.cmd.'
    exit 1
} finally {
    if ($lock) { $lock.Dispose() }
}
