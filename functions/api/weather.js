const latitude = 29.31;
const longitude = -94.7933;
const tideStation = '8771450';

const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
	status,
	headers: {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'public, max-age=600, s-maxage=600',
	},
});

const normalizeDegrees = (value) => ((value % 360) + 360) % 360;
const radians = (value) => value * Math.PI / 180;
const degrees = (value) => value * 180 / Math.PI;

const galvestonDate = () => Object.fromEntries(
	new Intl.DateTimeFormat('en-US', {
		timeZone: 'America/Chicago', year: 'numeric', month: 'numeric', day: 'numeric',
	}).formatToParts(new Date()).filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, Number(value)]),
);

function galvestonSolarTime(isSunrise) {
	const localParts = galvestonDate();
	const date = new Date(Date.UTC(localParts.year, localParts.month - 1, localParts.day));
	const yearStart = Date.UTC(localParts.year, 0, 0);
	const day = Math.floor((date.getTime() - yearStart) / 86400000);
	const longitudeHour = longitude / 15;
	const approximateTime = day + (((isSunrise ? 6 : 18) - longitudeHour) / 24);
	const meanAnomaly = (0.9856 * approximateTime) - 3.289;
	let trueLongitude = meanAnomaly + (1.916 * Math.sin(radians(meanAnomaly))) + (0.020 * Math.sin(radians(2 * meanAnomaly))) + 282.634;
	trueLongitude = normalizeDegrees(trueLongitude);
	let rightAscension = normalizeDegrees(degrees(Math.atan(0.91764 * Math.tan(radians(trueLongitude)))));
	rightAscension += (Math.floor(trueLongitude / 90) * 90) - (Math.floor(rightAscension / 90) * 90);
	rightAscension /= 15;
	const sinDeclination = 0.39782 * Math.sin(radians(trueLongitude));
	const cosDeclination = Math.cos(Math.asin(sinDeclination));
	const cosHourAngle = (Math.cos(radians(90.833)) - (sinDeclination * Math.sin(radians(latitude)))) /
		(cosDeclination * Math.cos(radians(latitude)));
	const hourAngleDegrees = degrees(Math.acos(cosHourAngle));
	const hourAngle = (isSunrise ? 360 - hourAngleDegrees : hourAngleDegrees) / 15;
	const localMeanTime = hourAngle + rightAscension - (0.06571 * approximateTime) - 6.622;
	const utcHours = ((localMeanTime - longitudeHour) % 24 + 24) % 24;
	const utcDayOffset = !isSunrise && longitude < 0 && utcHours < 12 ? 24 : 0;
	return new Date(Date.UTC(localParts.year, localParts.month - 1, localParts.day, 0, 0, 0) + (utcHours + utcDayOffset) * 3600000).toISOString();
}

const compassDirection = (degreesValue) => {
	if (!Number.isFinite(degreesValue)) return '';
	const points = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
	return points[Math.round(degreesValue / 22.5) % 16];
};

export async function onRequestGet({ request }) {
	try {
		const cache = caches.default;
		const cacheKey = new Request(new URL('/api/weather?cache=v1', request.url));
		const cached = await cache.match(cacheKey);
		if (cached) return cached;

		const nwsHeaders = {
			Accept: 'application/geo+json',
			'User-Agent': 'Coast2Road weather display (info@coast2road.com)',
		};
		const pointsResponse = await fetch(`https://api.weather.gov/points/${latitude},${longitude}`, { headers: nwsHeaders });
		if (!pointsResponse.ok) throw new Error('NWS location lookup failed');
		const points = await pointsResponse.json();

		const stationsResponse = await fetch(points.properties.observationStations, { headers: nwsHeaders });
		if (!stationsResponse.ok) throw new Error('NWS station lookup failed');
		const stations = await stationsResponse.json();
		const stationUrl = stations.features?.[0]?.id;
		if (!stationUrl) throw new Error('No NWS observation station found');

		const tideUrl = new URL('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter');
		const localDate = galvestonDate();
		const tideBeginDate = `${localDate.year}${String(localDate.month).padStart(2, '0')}${String(localDate.day).padStart(2, '0')}`;
		Object.entries({
			product: 'predictions', application: 'coast2road.com', station: tideStation,
			begin_date: tideBeginDate, range: '48', datum: 'MLLW', time_zone: 'gmt', units: 'english',
			interval: 'hilo', format: 'json',
		}).forEach(([key, value]) => tideUrl.searchParams.set(key, value));

		const [observationResponse, forecastResponse, tideResponse] = await Promise.all([
			fetch(`${stationUrl}/observations/latest`, { headers: nwsHeaders }),
			fetch(points.properties.forecast, { headers: nwsHeaders }),
			fetch(tideUrl),
		]);
		if (!observationResponse.ok || !forecastResponse.ok || !tideResponse.ok) throw new Error('Live weather source failed');

		const observation = await observationResponse.json();
		const forecast = await forecastResponse.json();
		const tideData = await tideResponse.json();
		const observed = observation.properties;
		const forecastPeriods = forecast.properties.periods || [];
		const temperature = Number.isFinite(observed.temperature?.value)
			? Math.round((observed.temperature.value * 9 / 5) + 32)
			: forecastPeriods[0]?.temperature;
		const windKnots = Number.isFinite(observed.windSpeed?.value)
			? Math.round(observed.windSpeed.value * 0.539957)
			: null;
		const now = Date.now();
		const tides = (tideData.predictions || [])
			.map((prediction) => ({
				type: prediction.type === 'H' ? 'High' : 'Low',
				time: `${prediction.t.replace(' ', 'T')}:00Z`,
				height: Number(prediction.v),
			}))
			.filter((prediction) => new Date(prediction.time).getTime() > now)
			.slice(0, 2);

		const payload = {
			current: {
				temperature,
				condition: observed.textDescription || forecastPeriods[0]?.shortForecast || 'Current conditions',
				windDirection: compassDirection(observed.windDirection?.value),
				windKnots,
			},
			forecast: forecastPeriods.filter((period) => period.isDaytime).slice(0, 3).map((period) => ({
				name: period.name,
				temperature: period.temperature,
				condition: period.shortForecast,
			})),
			tides,
			sunrise: galvestonSolarTime(true),
			sunset: galvestonSolarTime(false),
			updated: new Date().toISOString(),
			sources: { weather: 'National Weather Service', tides: 'NOAA Galveston Pier 21' },
		};

		const response = jsonResponse(payload);
		await cache.put(cacheKey, response.clone());
		return response;
	} catch (error) {
		return jsonResponse({ error: 'Live weather data is temporarily unavailable.' }, 503);
	}
}
