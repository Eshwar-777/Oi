import { Box, Button, Container, Stack, Typography } from "@mui/material";
import { BrandMark, SectionHeader } from "@oi/design-system-web";

const desktopDownloadUrl = import.meta.env.VITE_DESKTOP_DOWNLOAD_URL || "/downloads/oi-desktop.dmg";
const extensionDownloadUrl = import.meta.env.VITE_EXTENSION_DOWNLOAD_URL || "/downloads/oi-extension.zip";
const iosDownloadUrl = import.meta.env.VITE_IOS_DOWNLOAD_URL || "";
const androidDownloadUrl = import.meta.env.VITE_ANDROID_DOWNLOAD_URL || "";

const mushroomNodes = [
  { left: "18%", top: "22%", delay: "0s", tint: "amber" },
  { left: "50%", top: "16%", delay: "1.2s", tint: "moss" },
  { left: "80%", top: "30%", delay: "2.4s", tint: "amber" },
  { left: "34%", top: "64%", delay: "3.6s", tint: "moss" },
  { left: "70%", top: "74%", delay: "4.8s", tint: "amber" },
] as const;

const introPoints = [
  {
    title: "Tell it what to do",
    description: "Start with a simple request instead of clicking through every step yourself.",
  },
  {
    title: "Watch it happen",
    description: "See the task play out live, even when it is running on another device.",
  },
  {
    title: "Run it when you want",
    description: "Start now, set it for later, or come back when the timing is right.",
  },
] as const;

function HeroLoop() {
  return (
    <Box
      sx={{
        position: "relative",
        minHeight: { xs: 360, md: "calc(100vh - 220px)" },
        height: "100%",
        borderRadius: { xs: "30px", md: "38px" },
        overflow: "hidden",
        border: "1px solid rgba(255,255,255,0.08)",
        background:
          "radial-gradient(circle at 28% 16%, rgba(95, 146, 94, 0.24) 0%, rgba(95, 146, 94, 0) 24%), radial-gradient(circle at 82% 18%, rgba(204, 129, 64, 0.18) 0%, rgba(204, 129, 64, 0) 22%), linear-gradient(180deg, #0b0b0b 0%, #060606 100%)",
        boxShadow: "0 26px 56px rgba(0, 0, 0, 0.36)",
      }}
    >
      <Box
        sx={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0) 18%), radial-gradient(circle at 20% 84%, rgba(84, 163, 255, 0.1) 0%, rgba(84, 163, 255, 0) 24%), radial-gradient(circle at 84% 72%, rgba(255, 116, 77, 0.12) 0%, rgba(255, 116, 77, 0) 24%)",
          animation: "heroBackdropShift 14s ease-in-out infinite alternate",
          "@keyframes heroBackdropShift": {
            "0%": { transform: "scale(1) translate3d(0, 0, 0)" },
            "100%": { transform: "scale(1.08) translate3d(-2%, 2%, 0)" },
          },
        }}
      />
      <Box
        sx={{
          position: "absolute",
          inset: "12% 10% 16% 10%",
          borderRadius: "34px",
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.045) 0%, rgba(255,255,255,0.01) 28%, rgba(255,255,255,0) 100%)",
          border: "1px solid rgba(255,255,255,0.07)",
          transform: "perspective(900px) rotateX(58deg)",
          transformOrigin: "center center",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 40px 70px rgba(0, 0, 0, 0.45)",
        }}
      />
      <Box
        sx={{
          position: "absolute",
          inset: "24% 12% 12% 12%",
          borderRadius: "38px",
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0) 100%)",
          transform: "perspective(900px) rotateX(58deg)",
          transformOrigin: "center center",
          filter: "blur(1.5px)",
        }}
      />
      <Box
        sx={{
          position: "absolute",
          inset: "auto 0 0 0",
          height: "52%",
          background:
            "linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(3,3,3,0.34) 20%, rgba(3,3,3,0.94) 100%)",
        }}
      />

      {mushroomNodes.map((node) => (
        <Box
          key={`${node.left}-${node.top}`}
          sx={{
            position: "absolute",
            left: node.left,
            top: node.top,
            width: { xs: 72, md: 86 },
            height: { xs: 94, md: 108 },
            transform: "translate(-50%, -50%)",
          }}
        >
          <Box
            sx={{
              position: "absolute",
              inset: "8px auto auto 50%",
              width: { xs: 60, md: 74 },
              height: { xs: 36, md: 44 },
              transform: "translateX(-50%)",
              borderRadius: "999px 999px 18px 18px",
              background:
                node.tint === "amber"
                  ? "linear-gradient(180deg, #ffc572 0%, #ff944d 45%, #8f3c20 100%)"
                  : "linear-gradient(180deg, #ebf59e 0%, #9dce62 46%, #456326 100%)",
              boxShadow:
                node.tint === "amber"
                  ? "0 12px 26px rgba(255, 144, 72, 0.24)"
                  : "0 12px 26px rgba(121, 191, 105, 0.22)",
            }}
          />
          <Box
            sx={{
              position: "absolute",
              inset: "20px auto auto 50%",
              width: { xs: 38, md: 46 },
              height: { xs: 18, md: 22 },
              transform: "translateX(-50%)",
              borderRadius: "999px",
              background:
                node.tint === "amber"
                  ? "rgba(255, 240, 214, 0.94)"
                  : "rgba(248, 255, 228, 0.92)",
              filter: "blur(0.8px)",
            }}
          />
          <Box
            sx={{
              position: "absolute",
              inset: "36px auto auto 50%",
              width: { xs: 20, md: 24 },
              height: { xs: 40, md: 48 },
              transform: "translateX(-50%)",
              borderRadius: "999px",
              background: "linear-gradient(180deg, #f6efde 0%, #b8aa90 100%)",
              boxShadow: "0 6px 18px rgba(0, 0, 0, 0.2)",
            }}
          />
          <Box
            sx={{
              position: "absolute",
              inset: "18px auto auto 50%",
              width: { xs: 94, md: 112 },
              height: { xs: 94, md: 112 },
              transform: "translateX(-50%)",
              borderRadius: "50%",
              border: "1px solid rgba(255,255,255,0.14)",
              background:
                node.tint === "amber"
                  ? "radial-gradient(circle, rgba(255, 177, 92, 0.12) 0%, rgba(255, 177, 92, 0.02) 45%, rgba(255, 177, 92, 0) 72%)"
                  : "radial-gradient(circle, rgba(152, 214, 118, 0.12) 0%, rgba(152, 214, 118, 0.02) 45%, rgba(152, 214, 118, 0) 72%)",
              animation: "heroNodePulse 6s ease-in-out infinite",
              animationDelay: node.delay,
              "@keyframes heroNodePulse": {
                "0%, 14%, 100%": {
                  opacity: 0.12,
                  transform: "translateX(-50%) scale(0.88)",
                },
                "20%, 30%": {
                  opacity: 1,
                  transform: "translateX(-50%) scale(1.06)",
                },
              },
            }}
          />
        </Box>
      ))}

      <Box
        sx={{
          position: "absolute",
          left: { xs: "20%", md: "18%" },
          top: { xs: "20%", md: "19%" },
          width: { xs: 260, md: 360 },
          height: { xs: 196, md: 260 },
          pointerEvents: "none",
          "& path": {
            fill: "none",
            stroke: "rgba(160, 220, 255, 0.16)",
            strokeWidth: 2,
            strokeDasharray: "8 14",
            strokeLinecap: "round",
            animation: "heroTrailFlow 9s linear infinite",
          },
          "@keyframes heroTrailFlow": {
            from: { strokeDashoffset: 0 },
            to: { strokeDashoffset: -100 },
          },
        }}
      >
        <svg viewBox="0 0 360 260" width="100%" height="100%" aria-hidden="true">
          <path d="M0 18 C28 0, 82 12, 114 20 S170 30, 190 18 S266 14, 286 46 S308 104, 240 146 S126 184, 74 170 S34 136, 66 108 S156 74, 214 92 S288 156, 360 236" />
        </svg>
      </Box>

      <Box
        sx={{
          position: "absolute",
          left: { xs: "20%", md: "18%" },
          top: { xs: "20%", md: "19%" },
          width: 58,
          height: 58,
          animation: "heroOrbHop 9s cubic-bezier(0.32, 0.08, 0.16, 1) infinite",
          "@keyframes heroOrbHop": {
            "0%, 10%": { transform: "translate(0, 0) scale(1)" },
            "16%": { transform: "translate(94px, -28px) scale(0.94)" },
            "22%, 30%": { transform: "translate(132px, -8px) scale(1)" },
            "38%": { transform: "translate(234px, 26px) scale(0.95)" },
            "44%, 54%": { transform: "translate(276px, 50px) scale(1)" },
            "62%": { transform: "translate(148px, 126px) scale(0.94)" },
            "68%, 76%": { transform: "translate(114px, 154px) scale(1)" },
            "84%": { transform: "translate(250px, 188px) scale(0.95)" },
            "90%, 100%": { transform: "translate(286px, 220px) scale(1)" },
          },
        }}
      >
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(255,255,255,0.08) 0%, rgba(163, 220, 255, 0.14) 22%, rgba(163, 220, 255, 0) 72%)",
            filter: "blur(7px)",
            transform: "scale(1.1)",
          }}
        />
        <Box
          sx={{
            position: "absolute",
            left: 6,
            top: 21,
            width: 42,
            height: 14,
            borderRadius: "999px",
            background:
              "linear-gradient(90deg, rgba(139, 214, 255, 0) 0%, rgba(139, 214, 255, 0.14) 34%, rgba(139, 214, 255, 0.32) 72%, rgba(255,255,255,0.06) 100%)",
            filter: "blur(5px)",
            transform: "translateX(-82%)",
          }}
        />
        <Box
          sx={{
            position: "absolute",
            left: 16,
            top: 16,
            width: 26,
            height: 26,
            borderRadius: "50%",
            background:
              "radial-gradient(circle at 35% 35%, rgba(255,255,255,0.98) 0%, rgba(210, 242, 255, 0.94) 24%, rgba(124, 206, 255, 0.9) 58%, rgba(87, 181, 255, 0.76) 78%, rgba(87, 181, 255, 0.16) 100%)",
            boxShadow:
              "0 0 0 6px rgba(120, 198, 255, 0.08), 0 0 24px rgba(120, 198, 255, 0.34), 0 0 54px rgba(120, 198, 255, 0.18)",
          }}
        />
        <Box
          sx={{
            position: "absolute",
            left: 23,
            top: 23,
            width: 7,
            height: 7,
            borderRadius: "50%",
            backgroundColor: "rgba(255,255,255,0.98)",
            filter: "blur(0.35px)",
          }}
        />
      </Box>
    </Box>
  );
}

export function LandingPage() {
  return (
    <Box
      sx={{
        minHeight: "100vh",
        position: "relative",
        overflow: "hidden",
        background: "linear-gradient(180deg, #f7f8f5 0%, #f1f2ed 100%)",
      }}
    >
      <Box
        sx={{
          position: "absolute",
          inset: "-10% auto auto -12%",
          width: { xs: 280, md: 680 },
          height: { xs: 280, md: 680 },
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(133, 184, 110, 0.16) 0%, rgba(133, 184, 110, 0) 72%)",
          filter: "blur(18px)",
          animation: "pageWashOne 18s ease-in-out infinite alternate",
          "@keyframes pageWashOne": {
            "0%": { transform: "translate3d(0, 0, 0) scale(1)" },
            "100%": { transform: "translate3d(6%, 8%, 0) scale(1.08)" },
          },
        }}
      />
      <Box
        sx={{
          position: "absolute",
          inset: "auto -14% -24% auto",
          width: { xs: 320, md: 760 },
          height: { xs: 320, md: 760 },
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(222, 186, 141, 0.18) 0%, rgba(222, 186, 141, 0) 72%)",
          filter: "blur(20px)",
          animation: "pageWashTwo 22s ease-in-out infinite alternate",
          "@keyframes pageWashTwo": {
            "0%": { transform: "translate3d(0, 0, 0) scale(1)" },
            "100%": { transform: "translate3d(-8%, -7%, 0) scale(1.12)" },
          },
        }}
      />

      <Container maxWidth={false} disableGutters sx={{ px: { xs: 2, sm: 3, md: 5, xl: 7 } }}>
        <Stack spacing={{ xs: 4, md: 5 }} sx={{ minHeight: "100vh", py: { xs: 2, md: 3 } }}>
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            gap={2}
            sx={{ position: "relative", zIndex: 1 }}
          >
            <BrandMark />
            <Button href="/chat" variant="contained" color="primary">
              Open app
            </Button>
          </Stack>

          <Box
            sx={{
              position: "relative",
              overflow: "hidden",
              flex: 1,
              display: "grid",
              alignItems: "stretch",
              borderRadius: { xs: "34px", md: "42px" },
              border: "1px solid rgba(255,255,255,0.45)",
              background:
                "linear-gradient(135deg, rgba(255,255,255,0.84) 0%, rgba(246,247,242,0.94) 50%, rgba(241,234,222,0.94) 100%)",
              boxShadow: "0 24px 60px rgba(58, 50, 38, 0.08)",
              px: { xs: 2, md: 3 },
              py: { xs: 2, md: 3 },
              minHeight: { xs: "auto", md: "calc(100vh - 126px)" },
            }}
          >
            <Box
              sx={{
                position: "absolute",
                inset: "-12% auto auto -8%",
                width: { xs: 240, md: 520 },
                height: { xs: 240, md: 520 },
                borderRadius: "50%",
                background:
                  "radial-gradient(circle, rgba(134, 185, 112, 0.12) 0%, rgba(134, 185, 112, 0) 72%)",
                filter: "blur(16px)",
                animation: "heroShellGlowOne 16s ease-in-out infinite alternate",
                "@keyframes heroShellGlowOne": {
                  "0%": { transform: "translate3d(0, 0, 0)" },
                  "100%": { transform: "translate3d(4%, 8%, 0)" },
                },
              }}
            />
            <Box
              sx={{
                position: "absolute",
                inset: "auto -10% -18% auto",
                width: { xs: 240, md: 540 },
                height: { xs: 240, md: 540 },
                borderRadius: "50%",
                background:
                  "radial-gradient(circle, rgba(226, 185, 130, 0.14) 0%, rgba(226, 185, 130, 0) 72%)",
                filter: "blur(16px)",
                animation: "heroShellGlowTwo 18s ease-in-out infinite alternate",
                "@keyframes heroShellGlowTwo": {
                  "0%": { transform: "translate3d(0, 0, 0)" },
                  "100%": { transform: "translate3d(-5%, -6%, 0)" },
                },
              }}
            />

            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: { xs: "1fr", md: "minmax(420px, 0.78fr) minmax(0, 1.22fr)" },
                gap: { xs: 3, md: 4 },
                alignItems: "center",
                position: "relative",
                minHeight: { md: "calc(100vh - 158px)" },
                zIndex: 2,
              }}
            >
              <Stack
                spacing={3}
                sx={{
                  px: { xs: 1, md: 2 },
                  py: { xs: 2, md: 0 },
                  alignItems: { md: "flex-start" },
                }}
              >
                <Box
                  sx={{
                    maxWidth: 560,
                    p: { xs: 2, md: 2.75 },
                    borderRadius: "30px",
                    border: "1px solid rgba(255,255,255,0.5)",
                    background:
                      "linear-gradient(135deg, rgba(250,251,247,0.9) 0%, rgba(246,248,241,0.82) 62%, rgba(242,245,236,0.74) 100%)",
                    backdropFilter: "blur(16px)",
                    boxShadow: "0 18px 38px rgba(52, 45, 35, 0.08)",
                  }}
                >
                  <Stack spacing={3}>
                    <SectionHeader
                      eyebrow="Oye"
                      title="Ask. Watch. Run."
                      description="Oye handles work inside the browser for you. You can watch it live, follow along across devices, and decide whether it should run now or later."
                    />

                    <Stack spacing={1.2}>
                      {introPoints.map((point) => (
                        <Box
                          key={point.title}
                          sx={{
                            p: 1.6,
                            borderRadius: "18px",
                            border: "1px solid rgba(108, 116, 104, 0.12)",
                            backgroundColor: "rgba(255,255,255,0.64)",
                          }}
                        >
                          <Typography variant="body2" fontWeight={800} sx={{ mb: 0.35 }}>
                            {point.title}
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            {point.description}
                          </Typography>
                        </Box>
                      ))}
                    </Stack>

                    <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                      <Button href="/chat" variant="contained" color="primary">
                        Launch chat
                      </Button>
                      <Button href={desktopDownloadUrl} variant="outlined" color="primary">
                        Download desktop app
                      </Button>
                    </Stack>

                    <Stack spacing={1.2}>
                      <Typography variant="overline" sx={{ color: "text.secondary", letterSpacing: 1 }}>
                        Install surfaces
                      </Typography>
                      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.25} useFlexGap flexWrap="wrap">
                        <Button href={extensionDownloadUrl} variant="outlined" color="primary">
                          Download extension
                        </Button>
                        {iosDownloadUrl ? (
                          <Button href={iosDownloadUrl} variant="outlined" color="primary">
                            Get iPhone app
                          </Button>
                        ) : null}
                        {androidDownloadUrl ? (
                          <Button href={androidDownloadUrl} variant="outlined" color="primary">
                            Get Android app
                          </Button>
                        ) : null}
                      </Stack>
                      <Typography variant="body2" color="text.secondary">
                        Production rollout recommendation: keep desktop and extension artifacts on versioned release URLs, and drive mobile installs with direct App Store and Play Store links.
                      </Typography>
                    </Stack>

                    <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                      <Button href="/settings/devices" variant="outlined" color="primary">
                        Pair devices
                      </Button>
                    </Stack>
                  </Stack>
                </Box>
              </Stack>

              <Box
                sx={{
                  width: "100%",
                  minHeight: { xs: 360, md: "calc(100vh - 206px)" },
                  py: { xs: 1, md: 0 },
                }}
              >
                <HeroLoop />
              </Box>
            </Box>
          </Box>
        </Stack>
      </Container>
    </Box>
  );
}
