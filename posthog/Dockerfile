# Overlay: the pinned PostHog image with a frontend built from frontend.patch.
#   docker build --build-arg POSTHOG_SHA=54c04a0f494dc0821b87e95c19dcade17a633591 -t posthog-meetup:local posthog/
# dist/ is PostHog's frontend-build stage output from a checkout at the same SHA with frontend.patch applied
# (README). Never push or publish this image: it contains PostHog's ee/ code.
ARG POSTHOG_SHA
FROM posthog/posthog:sha-${POSTHOG_SHA}
COPY --chown=posthog:posthog dist/ /tmp/meetup-dist/
# Replace dist wholesale: the stock image's chunks reference sourcemaps it no longer ships, and leftover
# chunks would fail collectstatic. Static assets are served from /code/staticfiles (WhiteNoise manifest
# storage), so replacing dist alone would still serve the old JS. The collectstatic env and the sourcemap
# strip mirror PostHog's own Dockerfile (posthog-build stage).
RUN rm -rf /code/frontend/dist && mv /tmp/meetup-dist /code/frontend/dist \
    && SKIP_SERVICE_VERSION_REQUIREMENTS=1 STATIC_COLLECTION=1 DATABASE_URL='postgres:///' REDIS_URL='redis:///' \
       python manage.py collectstatic --noinput --clear \
    && find /code/staticfiles /code/frontend/dist \( -name '*.map' -o -name '*.map.gz' -o -name '*.map.br' \) -delete \
    && grep -rlq MEETUP_PATCH_V1 /code/staticfiles
