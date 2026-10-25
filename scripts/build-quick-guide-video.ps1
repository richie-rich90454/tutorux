param(
    [string]$ScreenshotTool = "build/dev/tutorux_ui_screenshot.exe",
    [string]$OutputPath = "docs/tutorial/quick-guide.mp4"
)

$ErrorActionPreference = "Stop"
$screenshotPath = Join-Path (Get-Location) $ScreenshotTool
$outputFile = Join-Path (Get-Location) $OutputPath
$outputDirectory = Split-Path -Parent $outputFile
$workDirectory = Join-Path (Get-Location) "build/tutorial-video"
$ffmpegCommand = Get-Command ffmpeg -ErrorAction Stop
$fontPath = Join-Path $env:WINDIR "Fonts/segoeui.ttf"

if (-not (Test-Path -LiteralPath $screenshotPath -PathType Leaf)) {
    throw "Build the desktop screenshot tool first: $ScreenshotTool"
}
if (-not (Test-Path -LiteralPath $fontPath -PathType Leaf)) {
    $fontPath = Join-Path $env:WINDIR "Fonts/arial.ttf"
}
if (-not (Test-Path -LiteralPath $fontPath -PathType Leaf)) {
    throw "A readable Windows font is needed to render the video captions."
}

New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $workDirectory | Out-Null

$slides = @(
    @{ Mode = "session"; Caption = "Start a lesson, choose a student and keep the notebook close" },
    @{ Mode = "recording"; Caption = "Record each take and manage its synchronized tracks" },
    @{ Mode = "journal"; Caption = "Review progress across lessons in the teaching journal" },
    @{ Mode = "materials"; Caption = "Keep worksheets and audio alongside the lesson" },
    @{ Mode = "guides"; Caption = "Reuse and refine a guide for the next session" }
)

$concatFile = Join-Path $workDirectory "slides.txt"
$concatLines = [System.Collections.Generic.List[string]]::new()
foreach ($index in 0..($slides.Count - 1)) {
    $slide = $slides[$index]
    $frame = Join-Path $workDirectory ("slide-{0}.bmp" -f ($index + 1))
    & $screenshotPath $frame $slide.Mode
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $frame -PathType Leaf)) {
        throw "The app could not render the '$($slide.Mode)' tutorial view."
    }
    $concatLines.Add("file '$($frame.Replace('\', '/'))'")
    $concatLines.Add("duration 4")
}
$concatLines.Add("file '$((Join-Path $workDirectory 'slide-5.bmp').Replace('\', '/'))'")
[System.IO.File]::WriteAllLines($concatFile, $concatLines,
    [System.Text.UTF8Encoding]::new($false))

$fontFilterPath = $fontPath.Replace('\', '/').Replace(':', '\:')
$captionFilters = [System.Collections.Generic.List[string]]::new()
for ($index = 0; $index -lt $slides.Count; $index++) {
    $start = $index * 4
    $end = $start + 3.95
    $caption = $slides[$index].Caption.Replace("'", "\\'").Replace(':', '\:')
    $captionFilters.Add(
        "drawtext=fontfile='$fontFilterPath':text='$caption':fontcolor=white:fontsize=24:x=48:y=820:enable='between(t,$start,$end)'"
    )
}
$filter = "fps=30,scale=1280:800:flags=lanczos,pad=1280:900:0:0:color=0x102019," +
          ($captionFilters -join ",")

& $ffmpegCommand.Source -y -hide_banner -loglevel error `
    -f concat -safe 0 -i $concatFile `
    -vf $filter -t 20 -c:v libx264 -preset veryfast -crf 22 `
    -pix_fmt yuv420p -movflags +faststart -an $outputFile
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $outputFile -PathType Leaf)) {
    throw "FFmpeg could not produce the quick guide video."
}

Write-Output "Created $OutputPath"
